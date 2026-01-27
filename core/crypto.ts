/**
 * Cryptographic utilities for SDK2
 *
 * Provides BIP39 mnemonic and BIP32 key derivation functions.
 * Platform-independent - no browser-specific APIs.
 */

import * as bip39 from 'bip39';
import CryptoJS from 'crypto-js';
import elliptic from 'elliptic';

// =============================================================================
// Constants
// =============================================================================

const ec = new elliptic.ec('secp256k1');

/** secp256k1 curve order */
const CURVE_ORDER = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'
);

/** Default derivation path for Unicity (BIP44) */
export const DEFAULT_DERIVATION_PATH = "m/44'/0'/0'";

// =============================================================================
// Types
// =============================================================================

export interface MasterKey {
  privateKey: string;
  chainCode: string;
}

export interface DerivedKey {
  privateKey: string;
  chainCode: string;
}

export interface KeyPair {
  privateKey: string;
  publicKey: string;
}

export interface AddressInfo extends KeyPair {
  address: string;
  path: string;
  index: number;
}

// =============================================================================
// BIP39 Mnemonic Functions
// =============================================================================

/**
 * Generate a new BIP39 mnemonic phrase
 * @param strength - Entropy bits (128 = 12 words, 256 = 24 words)
 */
export function generateMnemonic(strength: 128 | 256 = 128): string {
  return bip39.generateMnemonic(strength);
}

/**
 * Validate a BIP39 mnemonic phrase
 */
export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic);
}

/**
 * Convert mnemonic to seed (64-byte hex string)
 * @param mnemonic - BIP39 mnemonic phrase
 * @param passphrase - Optional passphrase for additional security
 */
export async function mnemonicToSeed(
  mnemonic: string,
  passphrase: string = ''
): Promise<string> {
  const seedBuffer = await bip39.mnemonicToSeed(mnemonic, passphrase);
  return Buffer.from(seedBuffer).toString('hex');
}

/**
 * Synchronous version of mnemonicToSeed
 */
export function mnemonicToSeedSync(
  mnemonic: string,
  passphrase: string = ''
): string {
  const seedBuffer = bip39.mnemonicToSeedSync(mnemonic, passphrase);
  return Buffer.from(seedBuffer).toString('hex');
}

/**
 * Convert mnemonic to entropy (for recovery purposes)
 */
export function mnemonicToEntropy(mnemonic: string): string {
  return bip39.mnemonicToEntropy(mnemonic);
}

/**
 * Convert entropy to mnemonic
 */
export function entropyToMnemonic(entropy: string): string {
  return bip39.entropyToMnemonic(entropy);
}

// =============================================================================
// BIP32 Key Derivation
// =============================================================================

/**
 * Generate master key from seed (BIP32 standard)
 * Uses HMAC-SHA512 with key "Bitcoin seed"
 */
export function generateMasterKey(seedHex: string): MasterKey {
  const I = CryptoJS.HmacSHA512(
    CryptoJS.enc.Hex.parse(seedHex),
    CryptoJS.enc.Utf8.parse('Bitcoin seed')
  ).toString();

  const IL = I.substring(0, 64); // Left 32 bytes - master private key
  const IR = I.substring(64); // Right 32 bytes - master chain code

  // Validate master key
  const masterKeyBigInt = BigInt('0x' + IL);
  if (masterKeyBigInt === 0n || masterKeyBigInt >= CURVE_ORDER) {
    throw new Error('Invalid master key generated');
  }

  return {
    privateKey: IL,
    chainCode: IR,
  };
}

/**
 * Derive child key using BIP32 standard
 * @param parentPrivKey - Parent private key (64 hex chars)
 * @param parentChainCode - Parent chain code (64 hex chars)
 * @param index - Child index (>= 0x80000000 for hardened)
 */
export function deriveChildKey(
  parentPrivKey: string,
  parentChainCode: string,
  index: number
): DerivedKey {
  const isHardened = index >= 0x80000000;
  let data: string;

  if (isHardened) {
    // Hardened derivation: 0x00 || parentPrivKey || index
    const indexHex = index.toString(16).padStart(8, '0');
    data = '00' + parentPrivKey + indexHex;
  } else {
    // Non-hardened derivation: compressedPubKey || index
    const keyPair = ec.keyFromPrivate(parentPrivKey, 'hex');
    const compressedPubKey = keyPair.getPublic(true, 'hex');
    const indexHex = index.toString(16).padStart(8, '0');
    data = compressedPubKey + indexHex;
  }

  // HMAC-SHA512 with chain code as key
  const I = CryptoJS.HmacSHA512(
    CryptoJS.enc.Hex.parse(data),
    CryptoJS.enc.Hex.parse(parentChainCode)
  ).toString();

  const IL = I.substring(0, 64); // Left 32 bytes
  const IR = I.substring(64); // Right 32 bytes (new chain code)

  // Add IL to parent key mod n (curve order)
  const ilBigInt = BigInt('0x' + IL);
  const parentKeyBigInt = BigInt('0x' + parentPrivKey);

  // Check IL is valid (less than curve order)
  if (ilBigInt >= CURVE_ORDER) {
    throw new Error('Invalid key: IL >= curve order');
  }

  const childKeyBigInt = (ilBigInt + parentKeyBigInt) % CURVE_ORDER;

  // Check child key is valid (not zero)
  if (childKeyBigInt === 0n) {
    throw new Error('Invalid key: child key is zero');
  }

  const childPrivKey = childKeyBigInt.toString(16).padStart(64, '0');

  return {
    privateKey: childPrivKey,
    chainCode: IR,
  };
}

/**
 * Derive key at a full BIP32/BIP44 path
 * @param masterPrivKey - Master private key
 * @param masterChainCode - Master chain code
 * @param path - BIP44 path like "m/44'/0'/0'/0/0"
 */
export function deriveKeyAtPath(
  masterPrivKey: string,
  masterChainCode: string,
  path: string
): DerivedKey {
  const pathParts = path.replace('m/', '').split('/');

  let currentKey = masterPrivKey;
  let currentChainCode = masterChainCode;

  for (const part of pathParts) {
    const isHardened = part.endsWith("'") || part.endsWith('h');
    const indexStr = part.replace(/['h]$/, '');
    let index = parseInt(indexStr, 10);

    if (isHardened) {
      index += 0x80000000; // Add hardened offset
    }

    const derived = deriveChildKey(currentKey, currentChainCode, index);
    currentKey = derived.privateKey;
    currentChainCode = derived.chainCode;
  }

  return {
    privateKey: currentKey,
    chainCode: currentChainCode,
  };
}

// =============================================================================
// Key Pair Operations
// =============================================================================

/**
 * Get public key from private key
 * @param privateKey - Private key as hex string
 * @param compressed - Return compressed public key (default: true)
 */
export function getPublicKey(privateKey: string, compressed: boolean = true): string {
  const keyPair = ec.keyFromPrivate(privateKey, 'hex');
  return keyPair.getPublic(compressed, 'hex');
}

/**
 * Create key pair from private key
 */
export function createKeyPair(privateKey: string): KeyPair {
  return {
    privateKey,
    publicKey: getPublicKey(privateKey),
  };
}

// =============================================================================
// Hash Functions
// =============================================================================

/**
 * Compute SHA256 hash
 */
export function sha256(data: string, inputEncoding: 'hex' | 'utf8' = 'hex'): string {
  const parsed =
    inputEncoding === 'hex'
      ? CryptoJS.enc.Hex.parse(data)
      : CryptoJS.enc.Utf8.parse(data);
  return CryptoJS.SHA256(parsed).toString();
}

/**
 * Compute RIPEMD160 hash
 */
export function ripemd160(data: string, inputEncoding: 'hex' | 'utf8' = 'hex'): string {
  const parsed =
    inputEncoding === 'hex'
      ? CryptoJS.enc.Hex.parse(data)
      : CryptoJS.enc.Utf8.parse(data);
  return CryptoJS.RIPEMD160(parsed).toString();
}

/**
 * Compute HASH160 (SHA256 -> RIPEMD160)
 */
export function hash160(data: string): string {
  const sha = sha256(data, 'hex');
  return ripemd160(sha, 'hex');
}

/**
 * Compute double SHA256
 */
export function doubleSha256(data: string, inputEncoding: 'hex' | 'utf8' = 'hex'): string {
  const first = sha256(data, inputEncoding);
  return sha256(first, 'hex');
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Convert hex string to Uint8Array
 */
export function hexToBytes(hex: string): Uint8Array {
  const matches = hex.match(/../g);
  if (!matches) {
    return new Uint8Array(0);
  }
  return Uint8Array.from(matches.map((x) => parseInt(x, 16)));
}

/**
 * Convert Uint8Array to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate random bytes as hex string
 */
export function randomBytes(length: number): string {
  const words = CryptoJS.lib.WordArray.random(length);
  return words.toString(CryptoJS.enc.Hex);
}

// =============================================================================
// High-Level Functions
// =============================================================================

/**
 * Generate identity from mnemonic
 * Returns master key derived from mnemonic seed
 */
export async function identityFromMnemonic(
  mnemonic: string,
  passphrase: string = ''
): Promise<MasterKey> {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }
  const seedHex = await mnemonicToSeed(mnemonic, passphrase);
  return generateMasterKey(seedHex);
}

/**
 * Synchronous version of identityFromMnemonic
 */
export function identityFromMnemonicSync(
  mnemonic: string,
  passphrase: string = ''
): MasterKey {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic phrase');
  }
  const seedHex = mnemonicToSeedSync(mnemonic, passphrase);
  return generateMasterKey(seedHex);
}

/**
 * Derive address info at a specific path
 */
export function deriveAddressInfo(
  masterKey: MasterKey,
  basePath: string,
  index: number,
  isChange: boolean = false
): AddressInfo {
  const chain = isChange ? 1 : 0;
  const fullPath = `${basePath}/${chain}/${index}`;

  const derived = deriveKeyAtPath(masterKey.privateKey, masterKey.chainCode, fullPath);
  const publicKey = getPublicKey(derived.privateKey);

  // Note: Address generation is platform-specific (bech32 encoding)
  // This returns the hash160 as address placeholder
  // Platform implementations should override with proper address encoding
  const address = hash160(publicKey);

  return {
    privateKey: derived.privateKey,
    publicKey,
    address,
    path: fullPath,
    index,
  };
}

// Re-export elliptic instance for advanced use cases
export { ec };
