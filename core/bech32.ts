/**
 * Bech32 Encoding/Decoding
 * BIP-173 implementation for address encoding
 */

import { SphereError } from './errors';

// =============================================================================
// Constants
// =============================================================================

/** Bech32 character set from BIP-173 */
export const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

/** Generator polynomial for checksum */
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

// =============================================================================
// Bit Conversion
// =============================================================================

/**
 * Convert between bit arrays (8→5 or 5→8)
 */
export function convertBits(
  data: number[],
  fromBits: number,
  toBits: number,
  pad: boolean
): number[] | null {
  let acc = 0;
  let bits = 0;
  const ret: number[] = [];
  const maxv = (1 << toBits) - 1;

  for (let i = 0; i < data.length; i++) {
    const value = data[i];
    if (value < 0 || value >> fromBits !== 0) return null;
    acc = (acc << fromBits) | value;
    bits += fromBits;
    while (bits >= toBits) {
      bits -= toBits;
      ret.push((acc >> bits) & maxv);
    }
  }

  if (pad) {
    if (bits > 0) {
      ret.push((acc << (toBits - bits)) & maxv);
    }
  } else if (bits >= fromBits || (acc << (toBits - bits)) & maxv) {
    return null;
  }

  return ret;
}

// =============================================================================
// Internal Functions
// =============================================================================

/**
 * Expand HRP for checksum calculation
 */
function hrpExpand(hrp: string): number[] {
  const ret: number[] = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}

/**
 * Calculate polymod checksum
 */
function bech32Polymod(values: number[]): number {
  let chk = 1;
  for (let p = 0; p < values.length; p++) {
    const top = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ values[p];
    for (let i = 0; i < 5; i++) {
      if ((top >> i) & 1) chk ^= GENERATOR[i];
    }
  }
  return chk;
}

/**
 * Create checksum for bech32
 */
function bech32Checksum(hrp: string, data: number[]): number[] {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = bech32Polymod(values) ^ 1;

  const ret: number[] = [];
  for (let p = 0; p < 6; p++) {
    ret.push((mod >> (5 * (5 - p))) & 31);
  }
  return ret;
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Encode data to bech32 address
 *
 * @example
 * ```ts
 * const address = encodeBech32('alpha', 1, pubkeyHash);
 * // 'alpha1qw...'
 * ```
 */
export function encodeBech32(
  hrp: string,
  version: number,
  program: Uint8Array
): string {
  if (version < 0 || version > 16) {
    throw new SphereError('Invalid witness version', 'VALIDATION_ERROR');
  }

  const converted = convertBits(Array.from(program), 8, 5, true);
  if (!converted) {
    throw new SphereError('Failed to convert bits', 'VALIDATION_ERROR');
  }

  const data = [version].concat(converted);
  const checksum = bech32Checksum(hrp, data);
  const combined = data.concat(checksum);

  let out = hrp + '1';
  for (let i = 0; i < combined.length; i++) {
    out += CHARSET[combined[i]];
  }

  return out;
}

/**
 * Decode bech32 address
 *
 * @example
 * ```ts
 * const result = decodeBech32('alpha1qw...');
 * // { hrp: 'alpha', witnessVersion: 1, data: Uint8Array }
 * ```
 */
export function decodeBech32(
  addr: string
): { hrp: string; witnessVersion: number; data: Uint8Array } | null {
  addr = addr.toLowerCase();

  const pos = addr.lastIndexOf('1');
  if (pos < 1) return null;

  const hrp = addr.substring(0, pos);
  const dataStr = addr.substring(pos + 1);

  const data: number[] = [];
  for (let i = 0; i < dataStr.length; i++) {
    const val = CHARSET.indexOf(dataStr[i]);
    if (val === -1) return null;
    data.push(val);
  }

  // Validate checksum
  const checksum = bech32Checksum(hrp, data.slice(0, -6));
  for (let i = 0; i < 6; i++) {
    if (checksum[i] !== data[data.length - 6 + i]) {
      return null;
    }
  }

  const version = data[0];
  const program = convertBits(data.slice(1, -6), 5, 8, false);
  if (!program) return null;

  return {
    hrp,
    witnessVersion: version,
    data: Uint8Array.from(program),
  };
}

/**
 * Create address from public key hash
 *
 * @example
 * ```ts
 * const address = createAddress('alpha', pubkeyHash);
 * // 'alpha1...'
 * ```
 */
export function createAddress(hrp: string, pubkeyHash: Uint8Array | string): string {
  const hashBytes = typeof pubkeyHash === 'string'
    ? Uint8Array.from(Buffer.from(pubkeyHash, 'hex'))
    : pubkeyHash;

  return encodeBech32(hrp, 1, hashBytes);
}

/**
 * Validate bech32 address
 */
export function isValidBech32(addr: string): boolean {
  return decodeBech32(addr) !== null;
}

/**
 * Get HRP from address
 */
export function getAddressHrp(addr: string): string | null {
  const result = decodeBech32(addr);
  return result?.hrp ?? null;
}

// =============================================================================
// Aliases for L1 SDK compatibility
// =============================================================================

/**
 * Alias for encodeBech32 (L1 SDK compatibility)
 */
export const createBech32 = encodeBech32;
