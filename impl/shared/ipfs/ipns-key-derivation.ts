/**
 * IPNS Key Derivation
 * Deterministic IPNS identity from secp256k1 private key using HKDF
 *
 * Derivation path:
 *   secp256k1 privateKey (hex)
 *     -> HKDF(sha256, key, info="ipfs-storage-ed25519-v1", 32 bytes)
 *     -> Ed25519 key pair
 *     -> libp2p PeerId
 *     -> IPNS name (e.g., "12D3KooW...")
 */

import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '../../../core/crypto';

// =============================================================================
// Constants
// =============================================================================

/**
 * HKDF info string for deriving Ed25519 keys from wallet keys.
 * Must match sphere webapp for cross-device compatibility.
 */
export const IPNS_HKDF_INFO = 'ipfs-storage-ed25519-v1';

// =============================================================================
// Dynamic Import Cache
// =============================================================================

let libp2pCryptoModule: typeof import('@libp2p/crypto/keys') | null = null;
let libp2pPeerIdModule: typeof import('@libp2p/peer-id') | null = null;

async function loadLibp2pModules() {
  if (!libp2pCryptoModule) {
    [libp2pCryptoModule, libp2pPeerIdModule] = await Promise.all([
      import('@libp2p/crypto/keys'),
      import('@libp2p/peer-id'),
    ]);
  }
  return {
    generateKeyPairFromSeed: libp2pCryptoModule!.generateKeyPairFromSeed,
    peerIdFromPrivateKey: libp2pPeerIdModule!.peerIdFromPrivateKey,
  };
}

// =============================================================================
// Key Derivation
// =============================================================================

/**
 * Derive Ed25519 key material from a secp256k1 private key using HKDF.
 *
 * @param privateKeyHex - secp256k1 private key in hex format
 * @param info - HKDF info string (default: IPNS_HKDF_INFO)
 * @returns 32-byte derived key material suitable for Ed25519 seed
 */
export function deriveEd25519KeyMaterial(
  privateKeyHex: string,
  info: string = IPNS_HKDF_INFO,
): Uint8Array {
  const walletSecret = hexToBytes(privateKeyHex);
  const infoBytes = new TextEncoder().encode(info);
  return hkdf(sha256, walletSecret, undefined, infoBytes, 32);
}

/**
 * Derive full IPNS identity (key pair + IPNS name) from a secp256k1 private key.
 *
 * @param privateKeyHex - secp256k1 private key in hex format
 * @returns Object with keyPair and ipnsName
 */
export async function deriveIpnsIdentity(
  privateKeyHex: string,
): Promise<{ keyPair: unknown; ipnsName: string }> {
  const { generateKeyPairFromSeed, peerIdFromPrivateKey } = await loadLibp2pModules();

  const derivedKey = deriveEd25519KeyMaterial(privateKeyHex);
  const keyPair = await generateKeyPairFromSeed('Ed25519', derivedKey);
  const peerId = peerIdFromPrivateKey(keyPair);

  return {
    keyPair,
    ipnsName: peerId.toString(),
  };
}

/**
 * Derive just the IPNS name from a secp256k1 private key.
 * Lighter than deriveIpnsIdentity when you don't need the key pair.
 *
 * @param privateKeyHex - secp256k1 private key in hex format
 * @returns IPNS name string (e.g., "12D3KooW...")
 */
export async function deriveIpnsName(
  privateKeyHex: string,
): Promise<string> {
  const { ipnsName } = await deriveIpnsIdentity(privateKeyHex);
  return ipnsName;
}
