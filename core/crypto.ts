/**
 * Cryptographic utilities for SDK2
 *
 * Provides BIP39 mnemonic and BIP32 key derivation functions.
 * Platform-independent - no browser-specific APIs.
 */

import * as bip39 from 'bip39';
import CryptoJS from 'crypto-js';
import elliptic from 'elliptic';
import { encodeBech32 } from './bech32';
import { SphereError } from './errors';

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
    throw new SphereError('Invalid master key generated', 'VALIDATION_ERROR');
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
    throw new SphereError('Invalid key: IL >= curve order', 'VALIDATION_ERROR');
  }

  const childKeyBigInt = (ilBigInt + parentKeyBigInt) % CURVE_ORDER;

  // Check child key is valid (not zero)
  if (childKeyBigInt === 0n) {
    throw new SphereError('Invalid key: child key is zero', 'VALIDATION_ERROR');
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

/**
 * Alias for hash160 (L1 SDK compatibility)
 */
export const computeHash160 = hash160;

/**
 * Convert hex string to Uint8Array for witness program
 */
export function hash160ToBytes(hash160Hex: string): Uint8Array {
  const matches = hash160Hex.match(/../g);
  if (!matches) return new Uint8Array(0);
  return Uint8Array.from(matches.map((x) => parseInt(x, 16)));
}

/**
 * Generate bech32 address from public key
 * @param publicKey - Compressed public key as hex string
 * @param prefix - Address prefix (default: "alpha")
 * @param witnessVersion - Witness version (default: 0 for P2WPKH)
 * @returns Bech32 encoded address
 */
export function publicKeyToAddress(
  publicKey: string,
  prefix: string = 'alpha',
  witnessVersion: number = 0
): string {
  const pubKeyHash = hash160(publicKey);
  const programBytes = hash160ToBytes(pubKeyHash);
  return encodeBech32(prefix, witnessVersion, programBytes);
}

/**
 * Get address info from private key
 */
export function privateKeyToAddressInfo(
  privateKey: string,
  prefix: string = 'alpha'
): { address: string; publicKey: string } {
  const publicKey = getPublicKey(privateKey);
  const address = publicKeyToAddress(publicKey, prefix);
  return { address, publicKey };
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
    throw new SphereError('Invalid mnemonic phrase', 'INVALID_IDENTITY');
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
    throw new SphereError('Invalid mnemonic phrase', 'INVALID_IDENTITY');
  }
  const seedHex = mnemonicToSeedSync(mnemonic, passphrase);
  return generateMasterKey(seedHex);
}

/**
 * Derive address info at a specific path
 * @param masterKey - Master key with privateKey and chainCode
 * @param basePath - Base derivation path (e.g., "m/44'/0'/0'")
 * @param index - Address index
 * @param isChange - Whether this is a change address (chain 1 vs 0)
 * @param prefix - Address prefix (default: "alpha")
 */
export function deriveAddressInfo(
  masterKey: MasterKey,
  basePath: string,
  index: number,
  isChange: boolean = false,
  prefix: string = 'alpha'
): AddressInfo {
  const chain = isChange ? 1 : 0;
  const fullPath = `${basePath}/${chain}/${index}`;

  const derived = deriveKeyAtPath(masterKey.privateKey, masterKey.chainCode, fullPath);
  const publicKey = getPublicKey(derived.privateKey);
  const address = publicKeyToAddress(publicKey, prefix);

  return {
    privateKey: derived.privateKey,
    publicKey,
    address,
    path: fullPath,
    index,
  };
}

/**
 * Generate full address info from private key with index and path
 * (L1 SDK compatibility)
 */
export function generateAddressInfo(
  privateKey: string,
  index: number,
  path: string,
  prefix: string = 'alpha'
): AddressInfo {
  const { address, publicKey } = privateKeyToAddressInfo(privateKey, prefix);
  return {
    privateKey,
    publicKey,
    address,
    path,
    index,
  };
}

// =============================================================================
// Message Signing (secp256k1 ECDSA with recoverable signature)
// =============================================================================

/** Prefix prepended to all signed messages (Bitcoin-like signed message format) */
export const SIGN_MESSAGE_PREFIX = 'Sphere Signed Message:\n';

/** Encode an integer as a Bitcoin-style compact varint */
function varint(n: number): Uint8Array {
  if (n < 253) return new Uint8Array([n]);
  const buf = new Uint8Array(3);
  buf[0] = 253;
  buf[1] = n & 0xff;
  buf[2] = (n >> 8) & 0xff;
  return buf;
}

/**
 * Hash a message for signing using the Bitcoin-like double-SHA256 scheme:
 *   SHA256(SHA256(varint(prefix.length) + prefix + varint(msg.length) + msg))
 *
 * @returns 64-char lowercase hex hash
 */
export function hashSignMessage(message: string): string {
  const prefix = new TextEncoder().encode(SIGN_MESSAGE_PREFIX);
  const msg = new TextEncoder().encode(message);
  const prefixLen = varint(prefix.length);
  const msgLen = varint(msg.length);
  const full = new Uint8Array(prefixLen.length + prefix.length + msgLen.length + msg.length);
  let off = 0;
  full.set(prefixLen, off); off += prefixLen.length;
  full.set(prefix, off); off += prefix.length;
  full.set(msgLen, off); off += msgLen.length;
  full.set(msg, off);
  const hex = Array.from(full).map(b => b.toString(16).padStart(2, '0')).join('');
  const h1 = CryptoJS.SHA256(CryptoJS.enc.Hex.parse(hex)).toString();
  return CryptoJS.SHA256(CryptoJS.enc.Hex.parse(h1)).toString();
}

/**
 * Sign a message with a secp256k1 private key.
 *
 * Returns a 130-character hex string: v (2 chars) + r (64 chars) + s (64 chars).
 * The recovery byte `v` is `31 + recoveryParam` (0-3).
 *
 * @param privateKeyHex - 64-char hex private key
 * @param message       - plaintext message to sign
 */
export function signMessage(privateKeyHex: string, message: string): string {
  const keyPair = ec.keyFromPrivate(privateKeyHex, 'hex');
  const hashHex = hashSignMessage(message);
  const hashBytes = Buffer.from(hashHex, 'hex');
  const sig = keyPair.sign(hashBytes, { canonical: true });

  // Find recovery parameter
  const pub = keyPair.getPublic();
  let recoveryParam = -1;
  for (let i = 0; i < 4; i++) {
    try {
      if (ec.recoverPubKey(hashBytes, sig, i).eq(pub)) {
        recoveryParam = i;
        break;
      }
    } catch { /* try next */ }
  }
  if (recoveryParam === -1) {
    throw new SphereError('Could not find recovery parameter', 'SIGNING_ERROR');
  }

  const v = (31 + recoveryParam).toString(16).padStart(2, '0');
  const r = sig.r.toString('hex').padStart(64, '0');
  const s = sig.s.toString('hex').padStart(64, '0');
  return v + r + s;
}

/**
 * Verify a signed message against a compressed secp256k1 public key.
 *
 * @param message       - The original plaintext message
 * @param signature     - 130-char hex signature (v + r + s)
 * @param expectedPubkey - 66-char compressed public key hex
 * @returns `true` if the signature is valid and matches the expected public key
 */
export function verifySignedMessage(
  message: string,
  signature: string,
  expectedPubkey: string,
): boolean {
  if (signature.length !== 130) return false;

  const v = parseInt(signature.slice(0, 2), 16) - 31;
  const r = signature.slice(2, 66);
  const s = signature.slice(66, 130);

  if (v < 0 || v > 3) return false;

  const hashHex = hashSignMessage(message);
  const hashBytes = Buffer.from(hashHex, 'hex');

  try {
    const recovered = ec.recoverPubKey(hashBytes, { r, s }, v);
    const recoveredHex = recovered.encode('hex', true); // compressed
    return recoveredHex === expectedPubkey;
  } catch {
    return false;
  }
}

// Re-export elliptic instance for advanced use cases
export { ec };
