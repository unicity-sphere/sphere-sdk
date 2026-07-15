/**
 * Cryptographic utilities for SDK2
 *
 * Provides BIP39 mnemonic and BIP32 key derivation functions.
 * Platform-independent - no browser-specific APIs.
 */

import { secp256k1 } from '@noble/curves/secp256k1.js';
import * as bip39 from 'bip39';
import CryptoJS from 'crypto-js';
import { SphereError } from './errors';

// =============================================================================
// Constants
// =============================================================================

/** secp256k1 curve order */
const CURVE_ORDER = BigInt(
  '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141'
);

/** A secp256k1 private key is exactly 32 bytes — 64 hex chars. */
const PRIVKEY_HEX_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Reject a malformed private key BEFORE it reaches the curve (#674 review).
 * `hexToBytes` coerces any non-hex character to a zero byte
 * (`parseInt('gg', 16)` → NaN → 0), so a right-length string with a stray
 * non-hex char would otherwise derive/sign with a DIFFERENT valid key and no
 * error — silently signing with an unintended key. secp256k1 already rejects
 * wrong-*length* input; this closes the same-length-wrong-chars hole.
 */
function assertPrivKeyHex(privateKeyHex: string): void {
  if (!PRIVKEY_HEX_RE.test(privateKeyHex)) {
    throw new SphereError(
      `Invalid private key: expected 64 hex chars, got ${privateKeyHex.length}`,
      'VALIDATION_ERROR',
    );
  }
}

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
    const compressedPubKey = getPublicKey(parentPrivKey, true);
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
  assertPrivKeyHex(privateKey);
  // SEC1 encoding: compressed = 02/03 prefix + x (33 bytes),
  // uncompressed = 04 prefix + x + y (65 bytes) — identical to elliptic's output.
  return bytesToHex(secp256k1.getPublicKey(hexToBytes(privateKey), compressed));
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
 * Derive key info at a specific path
 * @param masterKey - Master key with privateKey and chainCode
 * @param basePath - Base derivation path (e.g., "m/44'/0'/0'")
 * @param index - Address index
 * @param isChange - Whether this is a change address (chain 1 vs 0)
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

  return {
    privateKey: derived.privateKey,
    publicKey,
    path: fullPath,
    index,
  };
}

/**
 * Generate full key info from private key with index and path
 */
export function generateAddressInfo(
  privateKey: string,
  index: number,
  path: string
): AddressInfo {
  const publicKey = getPublicKey(privateKey);
  return {
    privateKey,
    publicKey,
    path,
    index,
  };
}

/**
 * Generate key info from master private key using HMAC-SHA512 derivation
 * This matches exactly the original index.html implementation
 * NOTE: This is NON-STANDARD derivation for legacy wallet compatibility.
 *
 * Dual-use: in `wif_hmac` derivation mode (legacy wallet import) this derives
 * the wallet's chainPubkey (used for L3 identity).
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
  assertPrivKeyHex(privateKeyHex);
  const hashHex = hashSignMessage(message);
  // prehash:false — the message is already hashed (double-SHA256 above);
  // lowS:true — canonical low-S signatures (same as elliptic's {canonical:true});
  // format:'recovered' — recoveryId(1) || r(32) || s(32), RFC6979-deterministic.
  const sigBytes = secp256k1.sign(hexToBytes(hashHex), hexToBytes(privateKeyHex), {
    prehash: false,
    lowS: true,
    format: 'recovered',
  });

  const recoveryParam = sigBytes[0];
  const v = (31 + recoveryParam).toString(16).padStart(2, '0');
  // r and s are fixed-width 32-byte big-endian — already left-padded.
  return v + bytesToHex(sigBytes.subarray(1));
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

  try {
    const recovered = secp256k1.Signature
      .fromHex(r + s, 'compact')
      .addRecoveryBit(v)
      .recoverPublicKey(hexToBytes(hashHex));
    return recovered.toHex(true) === expectedPubkey; // compressed
  } catch {
    return false;
  }
}

/**
 * Recover the compressed secp256k1 public key from a signed message.
 *
 * Use this when the server needs to identify the signer (not just verify
 * a signature against a known pubkey). Combined with `sphere.resolve(pubkey)`
 * it gives a fully cryptographically-attributable identity for backend auth,
 * without trusting any client-supplied identifier claim.
 *
 * @param message    - The plaintext that was signed
 * @param signature  - 130-char hex (v + r + s) as produced by `signMessage`
 * @returns          - Compressed 66-char hex pubkey
 * @throws           - On malformed signature length or out-of-range recovery byte
 */
export function recoverPubkeyFromSignature(message: string, signature: string): string {
  if (signature.length !== 130) {
    throw new SphereError(
      `Invalid signature length: expected 130 hex chars, got ${signature.length}`,
      'SIGNING_ERROR',
    );
  }

  const v = parseInt(signature.slice(0, 2), 16) - 31;
  const r = signature.slice(2, 66);
  const s = signature.slice(66, 130);

  if (v < 0 || v > 3) {
    throw new SphereError(
      `Invalid recovery byte: v=${v} out of range [0..3]`,
      'SIGNING_ERROR',
    );
  }

  const hashHex = hashSignMessage(message);

  const recovered = secp256k1.Signature
    .fromHex(r + s, 'compact')
    .addRecoveryBit(v)
    .recoverPublicKey(hexToBytes(hashHex));
  return recovered.toHex(true); // compressed
}
