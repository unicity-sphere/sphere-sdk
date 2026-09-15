/** Standard base64 (RFC 4648 §4, with padding), hand-rolled: no Buffer or atob, identical in Node and browsers. */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const INVALID = 0xff;
const SEXTETS = new Uint8Array(128).fill(INVALID);
for (let i = 0; i < ALPHABET.length; i++) SEXTETS[ALPHABET.charCodeAt(i)] = i;

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const triple = (bytes[i] << 16) | (b1 << 8) | b2;
    out += ALPHABET[triple >> 18] + ALPHABET[(triple >> 12) & 0x3f];
    out += i + 1 < bytes.length ? ALPHABET[(triple >> 6) & 0x3f] : '=';
    out += i + 2 < bytes.length ? ALPHABET[triple & 0x3f] : '=';
  }
  return out;
}

/** Decodes only the canonical spelling — padded, standard alphabet, zero padding bits. `null` for anything else. */
export function base64DecodeCanonical(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) return null;
  const padding = text.endsWith('==') ? 2 : text.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((text.length / 4) * 3 - padding);
  let buffer = 0;
  let bits = 0;
  let offset = 0;
  for (let i = 0; i < text.length - padding; i++) {
    const code = text.charCodeAt(i);
    const sextet = code < SEXTETS.length ? SEXTETS[code] : INVALID;
    if (sextet === INVALID) return null;
    buffer = ((buffer << 6) | sextet) & 0xfff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[offset++] = buffer >> bits;
    }
  }
  return (buffer & ((1 << bits) - 1)) === 0 ? out : null;
}
