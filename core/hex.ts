/**
 * Strict hex decoder/encoder utilities.
 *
 * Steelman³³: extracted from the 8+ duplicate inline implementations
 * across modules/, profile/, uxf/, transport/. Use this module's
 * hexToBytes everywhere — bare `Buffer.from(x, 'hex')` and
 * `match(/../g) + parseInt` patterns are silent-truncation traps:
 *
 *   - `Buffer.from('abc', 'hex')` returns `<Buffer ab>` (drops trailing 'c'
 *      with no error)
 *   - `Buffer.from('zz', 'hex')` returns `<Buffer 00>` (NaN coerced to 0)
 *   - `'abc'.match(/.{1,2}/g)` returns `['ab','c']`; `parseInt('c',16)=12`
 *      becomes a corrupt last byte
 *
 * The strict decoders in this module reject all of those classes.
 */

/**
 * Decode a hex string to Uint8Array. Strict: rejects non-string,
 * empty, odd-length, and any non-[0-9a-fA-F] chars.
 *
 * Use this for any hex that should always be non-empty (private keys,
 * pubkeys, content hashes). For wire-format-compatible decoders that
 * must accept empty strings, use {@link hexToBytesAllowEmpty}.
 */
export function hexToBytes(hex: string): Uint8Array {
  if (typeof hex !== 'string') {
    throw new TypeError(`hexToBytes: expected string, got ${typeof hex}`);
  }
  if (hex.length === 0) {
    throw new RangeError('hexToBytes: empty hex string');
  }
  if (hex.length % 2 !== 0) {
    throw new RangeError(`hexToBytes: odd-length hex string (${hex.length} chars)`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new RangeError('hexToBytes: contains non-hex characters');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Hex decoder that ALSO accepts the empty string (returns 0-byte
 * Uint8Array). Used by parsers that must round-trip empty byte fields
 * for wire-format compatibility (uxf/json, uxf/ipld). Still rejects
 * odd-length and non-hex chars.
 */
export function hexToBytesAllowEmpty(hex: string): Uint8Array {
  if (typeof hex !== 'string') {
    throw new TypeError(`hexToBytesAllowEmpty: expected string, got ${typeof hex}`);
  }
  if (hex.length === 0) return new Uint8Array(0);
  if (hex.length % 2 !== 0) {
    throw new RangeError(`hexToBytesAllowEmpty: odd-length hex string (${hex.length} chars)`);
  }
  if (!/^[0-9a-fA-F]+$/.test(hex)) {
    throw new RangeError('hexToBytesAllowEmpty: contains non-hex characters');
  }
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/** Lowercase hex encoding (no '0x' prefix). */
export function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}
