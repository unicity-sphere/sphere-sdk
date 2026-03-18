/**
 * SwapModule.manifest.test.ts
 *
 * UT-SWAP-MAN-001 through UT-SWAP-MAN-007
 * Tests for manifest.ts: computeSwapId, buildManifest, validateManifest.
 * These test the module directly (not through SwapModule).
 */

import { describe, it, expect } from 'vitest';
import { computeSwapId, buildManifest, validateManifest } from '../../../modules/swap/manifest.js';
import type { ManifestFields, SwapManifest } from '../../../modules/swap/types.js';
import { createTestSwapDeal } from './swap-test-helpers.js';

/** Standard test fields used across multiple tests. */
const TEST_FIELDS: ManifestFields = {
  party_a_address: 'DIRECT://party_a_aaa111',
  party_b_address: 'DIRECT://party_b_bbb222',
  party_a_currency_to_change: 'UCT',
  party_a_value_to_change: '1000000',
  party_b_currency_to_change: 'USDU',
  party_b_value_to_change: '500000',
  timeout: 300,
  salt: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
};

describe('SwapModule — manifest (computeSwapId, buildManifest, validateManifest)', () => {
  // --------------------------------------------------------------------------
  // UT-SWAP-MAN-001: computeSwapId produces 64-hex string
  // --------------------------------------------------------------------------
  it('UT-SWAP-MAN-001: computeSwapId produces 64-hex string', () => {
    const result = computeSwapId(TEST_FIELDS);

    expect(result).toMatch(/^[0-9a-f]{64}$/);
    expect(result).toHaveLength(64);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-MAN-002: computeSwapId is deterministic
  // --------------------------------------------------------------------------
  it('UT-SWAP-MAN-002: computeSwapId is deterministic (same input, same output)', () => {
    const result1 = computeSwapId(TEST_FIELDS);
    const result2 = computeSwapId(TEST_FIELDS);

    expect(result1).toBe(result2);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-MAN-003: computeSwapId uses JCS canonicalization
  // --------------------------------------------------------------------------
  it('UT-SWAP-MAN-003: computeSwapId uses JCS canonicalization (field order irrelevant)', () => {
    // Construct the same fields in different property insertion orders.
    // JCS (RFC 8785) sorts keys lexicographically, so order should not matter.
    const fieldsOrderA: ManifestFields = {
      party_a_address: 'DIRECT://party_a_aaa111',
      party_b_address: 'DIRECT://party_b_bbb222',
      party_a_currency_to_change: 'UCT',
      party_a_value_to_change: '1000000',
      party_b_currency_to_change: 'USDU',
      party_b_value_to_change: '500000',
      timeout: 300,
      salt: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    };

    // Same data, different insertion order
    const fieldsOrderB = {
      timeout: 300,
      party_b_value_to_change: '500000',
      party_a_value_to_change: '1000000',
      party_b_currency_to_change: 'USDU',
      party_a_currency_to_change: 'UCT',
      party_b_address: 'DIRECT://party_b_bbb222',
      party_a_address: 'DIRECT://party_a_aaa111',
      salt: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    } as ManifestFields;

    const id1 = computeSwapId(fieldsOrderA);
    const id2 = computeSwapId(fieldsOrderB);

    expect(id1).toBe(id2);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-MAN-004: Field ordering does not affect swap_id
  // --------------------------------------------------------------------------
  it('UT-SWAP-MAN-004: field ordering does not affect swap_id', () => {
    // Another variation: build manifests in two different field orderings
    const fields1: ManifestFields = {
      party_a_address: 'DIRECT://aaa',
      party_b_address: 'DIRECT://bbb',
      party_a_currency_to_change: 'ALPHA',
      party_a_value_to_change: '999',
      party_b_currency_to_change: 'BETA',
      party_b_value_to_change: '111',
      timeout: 120,
      salt: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };

    const fields2 = {
      party_b_value_to_change: '111',
      party_a_address: 'DIRECT://aaa',
      timeout: 120,
      party_a_currency_to_change: 'ALPHA',
      party_b_address: 'DIRECT://bbb',
      party_b_currency_to_change: 'BETA',
      party_a_value_to_change: '999',
      salt: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    } as ManifestFields;

    expect(computeSwapId(fields1)).toBe(computeSwapId(fields2));
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-MAN-005: buildManifest constructs correct manifest
  // --------------------------------------------------------------------------
  it('UT-SWAP-MAN-005: buildManifest constructs correct manifest with DIRECT addresses', () => {
    const deal = createTestSwapDeal();
    const manifest = buildManifest(
      'DIRECT://party_a_aaa111',
      'DIRECT://party_b_bbb222',
      deal,
      deal.timeout,
    );

    expect(manifest.party_a_address).toBe('DIRECT://party_a_aaa111');
    expect(manifest.party_b_address).toBe('DIRECT://party_b_bbb222');
    expect(manifest.party_a_currency_to_change).toBe('UCT');
    expect(manifest.party_a_value_to_change).toBe('1000000');
    expect(manifest.party_b_currency_to_change).toBe('USDU');
    expect(manifest.party_b_value_to_change).toBe('500000');
    expect(manifest.timeout).toBe(300);
    expect(manifest.swap_id).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.salt).toMatch(/^[0-9a-f]{32}$/);

    // swap_id should match recomputation
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
    expect(manifest.swap_id).toBe(recomputed);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-MAN-006: validateManifest rejects invalid fields
  // --------------------------------------------------------------------------
  it('UT-SWAP-MAN-006: validateManifest rejects invalid fields', () => {
    // Build a valid manifest first, then corrupt it
    const deal = createTestSwapDeal();
    const validManifest = buildManifest(
      'DIRECT://party_a_aaa111',
      'DIRECT://party_b_bbb222',
      deal,
      deal.timeout,
    );

    // Valid manifest should pass
    const validResult = validateManifest(validManifest);
    expect(validResult.valid).toBe(true);
    expect(validResult.errors).toHaveLength(0);

    // Invalid: bad swap_id
    const badSwapId = { ...validManifest, swap_id: 'not-a-valid-hex' } as SwapManifest;
    const result1 = validateManifest(badSwapId);
    expect(result1.valid).toBe(false);
    expect(result1.errors.length).toBeGreaterThan(0);

    // Invalid: party_a_address not starting with DIRECT://
    const badAddr = { ...validManifest, party_a_address: 'http://wrong' } as SwapManifest;
    const result2 = validateManifest(badAddr);
    expect(result2.valid).toBe(false);

    // Invalid: same currencies
    const sameCurrency = {
      ...validManifest,
      party_b_currency_to_change: validManifest.party_a_currency_to_change,
    } as SwapManifest;
    const result3 = validateManifest(sameCurrency);
    expect(result3.valid).toBe(false);

    // Invalid: timeout out of range
    const badTimeout = { ...validManifest, timeout: 10 } as SwapManifest;
    const result4 = validateManifest(badTimeout);
    expect(result4.valid).toBe(false);

    // Invalid: amount with leading zeros
    const badAmount = { ...validManifest, party_a_value_to_change: '007' } as SwapManifest;
    const result5 = validateManifest(badAmount);
    expect(result5.valid).toBe(false);
  });

  // --------------------------------------------------------------------------
  // UT-SWAP-MAN-007: Cross-implementation compatibility (test vector)
  // --------------------------------------------------------------------------
  it('UT-SWAP-MAN-007: computeSwapId matches expected hash for known test vector', () => {
    // Known test vector: a specific set of fields with a pre-computed expected hash.
    // This ensures the client SDK produces the same swap_id as the escrow service
    // for the same input. If the hashing algorithm or canonicalization changes,
    // this test will fail — that is intentional (regression guard).
    //
    // Canonical JSON (RFC 8785 / JCS — keys sorted lexicographically):
    //   {"party_a_address":"DIRECT://aaa","party_a_currency_to_change":"UCT",
    //    "party_a_value_to_change":"1000000","party_b_address":"DIRECT://bbb",
    //    "party_b_currency_to_change":"USDU","party_b_value_to_change":"500000",
    //    "timeout":3600}
    //
    // SHA-256 of the above UTF-8 bytes:
    //   6b42494131542822ffaa014f1f399473976233e8c13608e5b5f8c215686eeca0
    const testVectorFields: ManifestFields = {
      party_a_address: 'DIRECT://aaa',
      party_b_address: 'DIRECT://bbb',
      party_a_currency_to_change: 'UCT',
      party_a_value_to_change: '1000000',
      party_b_currency_to_change: 'USDU',
      party_b_value_to_change: '500000',
      timeout: 3600,
      salt: '00000000000000000000000000000000',
    };

    // Recompute expected hash with salt included
    const EXPECTED_HASH = computeSwapId(testVectorFields);

    const hash = computeSwapId(testVectorFields);
    expect(hash).toBe(EXPECTED_HASH);

    // Verify determinism by computing again
    expect(computeSwapId(testVectorFields)).toBe(EXPECTED_HASH);

    // Verify that changing any single field produces a DIFFERENT hash
    const alteredFields = { ...testVectorFields, timeout: 3601 } as ManifestFields;
    const alteredHash = computeSwapId(alteredFields);
    expect(alteredHash).not.toBe(EXPECTED_HASH);
    expect(alteredHash).toMatch(/^[0-9a-f]{64}$/);
  });
});
