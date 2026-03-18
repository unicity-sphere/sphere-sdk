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

import { isValidAddress, isValidDirectAddress } from '../../core/address.js';
import { signMessage, verifySignedMessage } from '../../core/crypto.js';
import type { ManifestFields, NametagBindingProof, SwapDeal, SwapManifest } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex for valid swap_id: exactly 64 lowercase hex characters. */
const SWAP_ID_RE = /^[0-9a-f]{64}$/;

/**
 * Strict DIRECT:// address regex used at signing boundaries.
 * Enforces hex-only pubkey suffix (64 chars) to uphold the colon-delimiter
 * invariant in signed messages. More permissive formats (e.g. test fixtures
 * with non-hex suffixes) are accepted elsewhere but must never reach signers.
 */
const DIRECT_HEX_RE = /^DIRECT:\/\/[0-9a-f]{64,80}$/;

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
 * @param escrowAddress - Optional escrow DIRECT:// address. When provided,
 *   the manifest includes escrow_address and protocol_version=2.
 * @returns A complete SwapManifest with computed swap_id.
 */
export function buildManifest(
  resolvedPartyA: string,
  resolvedPartyB: string,
  deal: SwapDeal,
  timeout: number,
  escrowAddress?: string,
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
    ...(escrowAddress !== undefined ? { escrow_address: escrowAddress, protocol_version: 2 } : {}),
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

  // party_a_address: valid Unicity address (DIRECT://, PROXY://, or @nametag)
  if (typeof manifest.party_a_address !== 'string' || !isValidAddress(manifest.party_a_address)) {
    errors.push('party_a_address must be a valid address (DIRECT://, PROXY://, or @nametag)');
  }

  // party_b_address: valid address, differs from party_a
  if (typeof manifest.party_b_address !== 'string' || !isValidAddress(manifest.party_b_address)) {
    errors.push('party_b_address must be a valid address (DIRECT://, PROXY://, or @nametag)');
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

  // v2 fields: if protocol_version is present, validate it and escrow_address
  if (manifest.protocol_version !== undefined) {
    if (manifest.protocol_version !== 2) {
      errors.push('protocol_version must be 2 when present');
    }
    if (typeof manifest.escrow_address !== 'string' || !isValidDirectAddress(manifest.escrow_address)) {
      errors.push('escrow_address must be a valid DIRECT:// address when protocol_version is 2');
    }
  }

  // Integrity check: recompute swap_id only if all other fields passed
  if (errors.length === 0) {
    const hashFields: ManifestFields = {
      party_a_address: manifest.party_a_address,
      party_b_address: manifest.party_b_address,
      party_a_currency_to_change: manifest.party_a_currency_to_change,
      party_a_value_to_change: manifest.party_a_value_to_change,
      party_b_currency_to_change: manifest.party_b_currency_to_change,
      party_b_value_to_change: manifest.party_b_value_to_change,
      timeout: manifest.timeout,
      salt: manifest.salt,
      ...(manifest.escrow_address !== undefined ? { escrow_address: manifest.escrow_address } : {}),
      ...(manifest.protocol_version !== undefined ? { protocol_version: manifest.protocol_version } : {}),
    };
    const recomputed = computeSwapId(hashFields);
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
 * fields. This is a lightweight check that does not validate field formats.
 * Includes v2 fields (escrow_address, protocol_version) in the hash when present.
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
    ...(manifest.escrow_address !== undefined ? { escrow_address: manifest.escrow_address } : {}),
    ...(manifest.protocol_version !== undefined ? { protocol_version: manifest.protocol_version } : {}),
  });
  return recomputed === manifest.swap_id;
}

// ---------------------------------------------------------------------------
// Swap Consent Signing (v2)
// ---------------------------------------------------------------------------

/**
 * Sign a swap manifest consent message.
 * Signs "swap_consent:{swapId}:{escrowAddress}" with the party's chain private key.
 *
 * @param privateKey - The signer's chain private key (hex).
 * @param swapId - The swap_id (64 lowercase hex chars).
 * @param escrowAddress - The escrow's DIRECT:// address.
 * @returns 130-char hex signature (v + r + s).
 */
export function signSwapManifest(privateKey: string, swapId: string, escrowAddress: string): string {
  // Message format: "swap_consent:{swapId}:{escrowAddress}"
  // Colon is used as a delimiter. swapId is guaranteed hex-only (no colons).
  // Enforce DIRECT_HEX_RE here — isValidDirectAddress() in core/address.ts is
  // intentionally permissive (accepts test fixtures); the signer must be strict.
  if (!DIRECT_HEX_RE.test(escrowAddress)) {
    throw new Error(`signSwapManifest: escrowAddress must be a DIRECT:// address with hex-only suffix, got "${escrowAddress.slice(0, 80)}"`);
  }
  const message = `swap_consent:${swapId}:${escrowAddress}`;
  return signMessage(privateKey, message);
}

/**
 * Verify a swap manifest consent signature.
 *
 * @param swapId - The swap_id (64 lowercase hex chars).
 * @param escrowAddress - The escrow's DIRECT:// address.
 * @param signature - 130-char hex signature to verify.
 * @param chainPubkey - Expected signer's 33-byte compressed pubkey (hex).
 * @returns true if the signature is valid and matches the expected pubkey.
 */
export function verifySwapSignature(
  swapId: string,
  escrowAddress: string,
  signature: string,
  chainPubkey: string,
): boolean {
  const message = `swap_consent:${swapId}:${escrowAddress}`;
  return verifySignedMessage(message, signature, chainPubkey);
}

// ---------------------------------------------------------------------------
// Nametag Binding (v2)
// ---------------------------------------------------------------------------

/**
 * Create a nametag binding proof.
 * Signs "nametag_bind:{nametag}:{directAddress}:{swapId}" with the party's
 * chain private key, proving the nametag owner authorized the address for
 * this swap.
 *
 * @param privateKey - The signer's chain private key (hex).
 * @param nametag - The human-readable nametag (without @).
 * @param directAddress - The party's resolved DIRECT:// address.
 * @param swapId - The swap_id (64 lowercase hex chars).
 * @param chainPubkey - The signer's 33-byte compressed chain pubkey (hex).
 * @returns A NametagBindingProof with the signature.
 */
/**
 * Maximum nametag length for binding proofs.
 * Matches core/address.ts NAMETAG_RE limit (1–30 chars) to prevent
 * binding proofs being created for nametags the SDK would otherwise reject.
 */
const MAX_NAMETAG_LEN = 30;

/**
 * Nametag character whitelist: must start with lowercase alphanumeric,
 * followed by lowercase alphanumeric, hyphen, or underscore.
 * Mirrors core/address.ts NAMETAG_RE = /^[a-z0-9][a-z0-9_-]{0,29}$/.
 */
const NAMETAG_RE = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * Returns true if the given nametag string is within acceptable bounds for
 * inclusion in a binding proof.
 */
function isValidNametag(nametag: string): boolean {
  return nametag.length > 0 && nametag.length <= MAX_NAMETAG_LEN && NAMETAG_RE.test(nametag);
}

export function createNametagBinding(
  privateKey: string,
  nametag: string,
  directAddress: string,
  swapId: string,
  chainPubkey: string,
): NametagBindingProof {
  if (!isValidNametag(nametag)) {
    throw new Error(`Invalid nametag for binding proof: "${nametag.slice(0, 80)}"`);
  }
  // Guard: directAddress must be a strict hex DIRECT:// address (DIRECT_HEX_RE).
  // Using DIRECT_HEX_RE (not the permissive isValidDirectAddress) aligns with
  // verifyNametagBinding, so every proof this function creates is verifiable.
  if (!DIRECT_HEX_RE.test(directAddress)) {
    throw new Error(`Invalid directAddress for binding proof: "${directAddress.slice(0, 80)}"`);
  }
  // Message format: "nametag_bind:{nametag}:{directAddress}:{swapId}"
  // Colon is used as a delimiter. nametag is [a-z0-9_-] (no colons, validated above).
  // swapId is hex-only (no colons). directAddress must be a DIRECT:// address where
  // the pubkey suffix is hex-only — enforced by caller validation before this point.
  const message = `nametag_bind:${nametag}:${directAddress}:${swapId}`;
  const signature = signMessage(privateKey, message);
  return { nametag, direct_address: directAddress, chain_pubkey: chainPubkey, signature };
}

/**
 * Verify a nametag binding proof.
 *
 * @param proof - The NametagBindingProof to verify.
 * @param swapId - The swap_id (64 lowercase hex chars).
 * @returns true if the signature is valid and matches the proof's chain_pubkey.
 */
export function verifyNametagBinding(
  proof: NametagBindingProof,
  swapId: string,
): boolean {
  // Reject structurally invalid nametags before computing the signed message.
  // This prevents a malicious peer from triggering a crypto operation on an
  // arbitrarily large string.
  if (!isValidNametag(proof.nametag)) return false;
  // Symmetric guard to createNametagBinding: enforce hex-only DIRECT:// address
  // to uphold the colon-delimiter invariant in the signed message.
  if (!DIRECT_HEX_RE.test(proof.direct_address)) return false;
  const message = `nametag_bind:${proof.nametag}:${proof.direct_address}:${swapId}`;
  return verifySignedMessage(message, proof.signature, proof.chain_pubkey);
}
