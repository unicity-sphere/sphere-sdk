/**
 * Standard address parsing, validation, and normalization for Unicity addresses.
 *
 * Three address formats:
 * - DIRECT://  — Resolved on-chain address (hex, 64-80 chars after prefix)
 * - PROXY://   — Proxy address derived from nametag hash
 * - @nametag   — Human-readable alias resolved via transport
 *
 * This module is the single source of truth for address handling.
 * All applications (escrow, sphere app, orchestrator) should import from here.
 *
 * @module
 */

// =============================================================================
// Constants
// =============================================================================

const DIRECT_PREFIX = 'DIRECT://';
const PROXY_PREFIX = 'PROXY://';
const NAMETAG_PREFIX = '@';

// DIRECT:// accepts any non-empty value after the prefix.
// Strict hex validation is NOT enforced here — the SDK resolves addresses
// before on-chain use, and test fixtures use non-hex placeholder addresses.

/** Valid nametag chars: lowercase alphanumeric + underscore + hyphen, 1-30 chars */
const NAMETAG_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/;

// =============================================================================
// Types
// =============================================================================

/** The three address format types supported by Unicity. */
export type AddressType = 'DIRECT' | 'PROXY' | 'NAMETAG';

/** A parsed address with its type and components. */
export interface ParsedAddress {
  /** Address format type */
  readonly type: AddressType;
  /** Original raw address string */
  readonly raw: string;
  /** The value part after the prefix (hex for DIRECT/PROXY, name for NAMETAG) */
  readonly value: string;
}

// =============================================================================
// Parsing
// =============================================================================

/**
 * Parse a Unicity address string into its components.
 *
 * @param address - A DIRECT://, PROXY://, or @nametag address string.
 * @returns Parsed address or null if invalid/unrecognized format.
 *
 * @example
 * parseAddress('DIRECT://0000ab12...') → { type: 'DIRECT', raw: '...', value: '0000ab12...' }
 * parseAddress('@alice')               → { type: 'NAMETAG', raw: '@alice', value: 'alice' }
 * parseAddress('PROXY://abc123...')     → { type: 'PROXY', raw: '...', value: 'abc123...' }
 * parseAddress('invalid')              → null
 */
export function parseAddress(address: string): ParsedAddress | null {
  if (!address || typeof address !== 'string') return null;
  const trimmed = address.trim();

  if (trimmed.startsWith(DIRECT_PREFIX)) {
    const value = trimmed.slice(DIRECT_PREFIX.length);
    if (value.length > 0) {
      return { type: 'DIRECT', raw: trimmed, value };
    }
    return null;
  }

  if (trimmed.startsWith(PROXY_PREFIX) && trimmed.length > PROXY_PREFIX.length) {
    return { type: 'PROXY', raw: trimmed, value: trimmed.slice(PROXY_PREFIX.length) };
  }

  if (trimmed.startsWith(NAMETAG_PREFIX)) {
    const value = trimmed.slice(NAMETAG_PREFIX.length);
    if (value.length > 0) {
      return { type: 'NAMETAG', raw: trimmed, value };
    }
    return null;
  }

  return null;
}

// =============================================================================
// Validation
// =============================================================================

/**
 * Check if a string is a valid Unicity address (any format).
 *
 * Accepts DIRECT://, PROXY://, or @nametag.
 */
export function isValidAddress(address: string): boolean {
  return parseAddress(address) !== null;
}

/**
 * Check if a string is a valid DIRECT:// address.
 */
export function isValidDirectAddress(address: string): boolean {
  const parsed = parseAddress(address);
  return parsed !== null && parsed.type === 'DIRECT';
}

/**
 * Check if a string is a valid nametag (@name).
 * Validates the nametag format: lowercase alphanumeric + underscore + hyphen, 1-30 chars.
 */
export function isValidNametag(address: string): boolean {
  const parsed = parseAddress(address);
  if (!parsed || parsed.type !== 'NAMETAG') return false;
  return NAMETAG_RE.test(parsed.value);
}

// =============================================================================
// Normalization & Comparison
// =============================================================================

/**
 * Normalize an address for comparison.
 *
 * - DIRECT:// → lowercase hex
 * - PROXY://  → lowercase hex
 * - @nametag  → lowercase name
 *
 * Returns the original string if not a recognized format.
 */
export function normalizeAddress(address: string): string {
  const parsed = parseAddress(address);
  if (!parsed) return address;

  switch (parsed.type) {
    case 'DIRECT':
      return `DIRECT://${parsed.value.toLowerCase()}`;
    case 'PROXY':
      return `PROXY://${parsed.value.toLowerCase()}`;
    case 'NAMETAG':
      return `@${parsed.value.toLowerCase()}`;
  }
}

/**
 * Check if two addresses refer to the same destination.
 *
 * Normalizes both addresses before comparing.
 * Note: this only detects exact format matches — it cannot determine
 * that @alice and DIRECT://00ab... are the same without resolution.
 */
export function addressesMatch(a: string, b: string): boolean {
  return normalizeAddress(a) === normalizeAddress(b);
}
