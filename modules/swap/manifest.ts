/**
 * Swap manifest construction, validation, and swap_id computation.
 *
 * The swap_id is computed as SHA-256 of the RFC 8785 (JCS) canonical JSON
 * serialization of the manifest fields (excluding swap_id itself).
 * This MUST produce byte-identical output to the escrow service's
 * computeSwapId in escrow-service/src/utils/hash.ts.
 *
 * @module
 */

import canonicalize from 'canonicalize';
import { sha256 } from '../../core/crypto.js';
import { randomHex } from '../../core/utils.js';

import type { ManifestFields, SwapDeal, SwapManifest } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex for valid swap_id: exactly 64 lowercase hex characters. */
const SWAP_ID_RE = /^[0-9a-f]{64}$/;

/** Regex for valid currency/coinId: 1-20 alphanumeric characters. */
const CURRENCY_RE = /^[A-Za-z0-9]{1,20}$/;

/** Regex for valid amount: positive integer string, no leading zeros. */
const AMOUNT_RE = /^[1-9][0-9]*$/;

/** Minimum timeout in seconds. */
const TIMEOUT_MIN = 60;

/** Maximum timeout in seconds (24 hours). */
const TIMEOUT_MAX = 86400;

// ---------------------------------------------------------------------------
// Swap ID Computation
// ---------------------------------------------------------------------------

/**
 * Compute the swap_id as SHA-256 of the RFC 8785 canonical JSON of the
 * manifest fields (excluding swap_id).
 *
 * This function produces output byte-identical to the escrow service's
 * `computeSwapId` (escrow-service/src/utils/hash.ts), which uses Node.js
 * `crypto.createHash('sha256')` over the same canonical JSON string.
 *
 * @param fields - The 7 manifest fields (without swap_id).
 * @returns Lowercase hex string (64 chars).
 * @throws Error if canonicalization fails.
 */
export function computeSwapId(fields: ManifestFields): string {
  const canonical = canonicalize(fields);
  if (!canonical) {
    throw new Error('Failed to canonicalize manifest fields');
  }
  return sha256(canonical, 'utf8');
}

// ---------------------------------------------------------------------------
// Manifest Construction
// ---------------------------------------------------------------------------

/**
 * Build a complete SwapManifest from resolved DIRECT:// addresses and a
 * SwapDeal. The swap_id is computed deterministically from the fields.
 *
 * @param resolvedPartyA - Party A's resolved DIRECT:// address.
 * @param resolvedPartyB - Party B's resolved DIRECT:// address.
 * @param deal - The user-facing swap deal (currencies, amounts, timeout).
 * @param timeout - Timeout in seconds (from deal.timeout).
 * @returns A complete SwapManifest with computed swap_id.
 */
export function buildManifest(
  resolvedPartyA: string,
  resolvedPartyB: string,
  deal: SwapDeal,
  timeout: number,
): SwapManifest {
  const fields: ManifestFields = {
    party_a_address: resolvedPartyA,
    party_b_address: resolvedPartyB,
    party_a_currency_to_change: deal.partyACurrency,
    party_a_value_to_change: deal.partyAAmount,
    party_b_currency_to_change: deal.partyBCurrency,
    party_b_value_to_change: deal.partyBAmount,
    timeout,
    salt: randomHex(16), // 32 hex chars — ensures unique swap_id per proposal
  };

  const swap_id = computeSwapId(fields);

  return { swap_id, ...fields };
}

// ---------------------------------------------------------------------------
// Manifest Validation
// ---------------------------------------------------------------------------

/**
 * Validate a SwapManifest against the rules defined in SWAP-SPEC section 17.2.
 * This mirrors the escrow's manifest-validator.ts validation rules, with
 * coinId max length aligned to 20 chars (AccountingModule limit) rather
 * than the escrow's 68-char limit.
 *
 * @param manifest - The manifest to validate.
 * @returns An object with `valid` boolean and `errors` array of strings.
 */
export function validateManifest(manifest: SwapManifest): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // swap_id: 64 lowercase hex chars
  if (typeof manifest.swap_id !== 'string' || !SWAP_ID_RE.test(manifest.swap_id)) {
    errors.push('swap_id must be exactly 64 lowercase hex characters');
  }

  // party_a_address: non-empty string starting with DIRECT://
  if (typeof manifest.party_a_address !== 'string' || !manifest.party_a_address.startsWith('DIRECT://')) {
    errors.push('party_a_address must be a non-empty string starting with DIRECT://');
  }

  // party_b_address: non-empty string starting with DIRECT://, differs from party_a
  if (typeof manifest.party_b_address !== 'string' || !manifest.party_b_address.startsWith('DIRECT://')) {
    errors.push('party_b_address must be a non-empty string starting with DIRECT://');
  } else if (manifest.party_b_address === manifest.party_a_address) {
    errors.push('party_b_address must differ from party_a_address');
  }

  // party_a_currency_to_change: 1-20 alphanumeric chars
  if (typeof manifest.party_a_currency_to_change !== 'string' || !CURRENCY_RE.test(manifest.party_a_currency_to_change)) {
    errors.push('party_a_currency_to_change must be 1-20 alphanumeric characters');
  }

  // party_b_currency_to_change: 1-20 alphanumeric chars, differs from party_a
  if (typeof manifest.party_b_currency_to_change !== 'string' || !CURRENCY_RE.test(manifest.party_b_currency_to_change)) {
    errors.push('party_b_currency_to_change must be 1-20 alphanumeric characters');
  } else if (manifest.party_b_currency_to_change === manifest.party_a_currency_to_change) {
    errors.push('party_b_currency_to_change must differ from party_a_currency_to_change');
  }

  // party_a_value_to_change: positive integer string, no leading zeros
  if (typeof manifest.party_a_value_to_change !== 'string' || !AMOUNT_RE.test(manifest.party_a_value_to_change)) {
    errors.push('party_a_value_to_change must be a positive integer string');
  }

  // party_b_value_to_change: positive integer string, no leading zeros
  if (typeof manifest.party_b_value_to_change !== 'string' || !AMOUNT_RE.test(manifest.party_b_value_to_change)) {
    errors.push('party_b_value_to_change must be a positive integer string');
  }

  // timeout: integer in [60, 86400]
  if (typeof manifest.timeout !== 'number' || !Number.isInteger(manifest.timeout) || manifest.timeout < TIMEOUT_MIN || manifest.timeout > TIMEOUT_MAX) {
    errors.push(`timeout must be an integer between ${TIMEOUT_MIN} and ${TIMEOUT_MAX}`);
  }

  // salt: 32 lowercase hex chars
  if (typeof manifest.salt !== 'string' || !/^[0-9a-f]{32}$/.test(manifest.salt)) {
    errors.push('salt must be exactly 32 lowercase hex characters');
  }

  // Integrity check: recompute swap_id only if all other fields passed
  if (errors.length === 0) {
    const recomputed = computeSwapId({
      party_a_address: manifest.party_a_address,
      party_b_address: manifest.party_b_address,
      party_a_currency_to_change: manifest.party_a_currency_to_change,
      party_a_value_to_change: manifest.party_a_value_to_change,
      party_b_currency_to_change: manifest.party_b_currency_to_change,
      party_b_value_to_change: manifest.party_b_value_to_change,
      timeout: manifest.timeout,
      salt: manifest.salt,
    });
    if (recomputed !== manifest.swap_id) {
      errors.push('swap_id does not match SHA-256 hash of manifest fields');
    }
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Manifest Integrity Verification
// ---------------------------------------------------------------------------

/**
 * Verify that a manifest's swap_id matches the SHA-256 hash of its other
 * 8 fields. This is a lightweight check that does not validate field formats.
 *
 * @param manifest - The manifest to verify.
 * @returns true if swap_id matches the recomputed hash.
 */
export function verifyManifestIntegrity(manifest: SwapManifest): boolean {
  const recomputed = computeSwapId({
    party_a_address: manifest.party_a_address,
    party_b_address: manifest.party_b_address,
    party_a_currency_to_change: manifest.party_a_currency_to_change,
    party_a_value_to_change: manifest.party_a_value_to_change,
    party_b_currency_to_change: manifest.party_b_currency_to_change,
    party_b_value_to_change: manifest.party_b_value_to_change,
    timeout: manifest.timeout,
    salt: manifest.salt,
  });
  return recomputed === manifest.swap_id;
}
