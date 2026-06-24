/**
 * Browser-safe UUID v4 generation.
 *
 * Kept dependency-free (no node:crypto require, unlike core/utils.ts) so it is
 * safe to import from the platform:'browser' bundles and the token-engine
 * subpath without dragging a Node builtin into them.
 */

/**
 * Generate a v4 UUID.
 *
 * Prefers `crypto.randomUUID()` (secure context; Safari 15.4+, Chrome 92+,
 * Node 19+). Falls back to deriving one from `crypto.getRandomValues()`, which
 * is available in every browser — including insecure / non-HTTPS contexts and
 * older WebViews — and in Node 20+. This avoids
 * `crypto.randomUUID is not a function` on sub-15.4 / insecure-context runtimes
 * (sphere-sdk#619), with no node:crypto fallback that would break browser bundles.
 */
export function randomUUID(): string {
  const c = globalThis.crypto;
  if (typeof c !== 'undefined' && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // RFC 4122 v4 from CSPRNG bytes.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10xx
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h[0]}${h[1]}${h[2]}${h[3]}-${h[4]}${h[5]}-${h[6]}${h[7]}-${h[8]}${h[9]}-${h[10]}${h[11]}${h[12]}${h[13]}${h[14]}${h[15]}`;
}
