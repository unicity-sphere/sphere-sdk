import { describe, it, expect } from 'vitest';
import {
  deriveEd25519KeyMaterial,
  IPNS_HKDF_INFO,
} from '../../../../../impl/shared/ipfs/ipns-key-derivation';

describe('IPNS Key Derivation', () => {
  // A known test private key (not real funds)
  const testPrivateKey = 'e8f32e723decf4051aefac8e2c93c9c5b214313817cdb01a1494b917c8436b35';

  describe('deriveEd25519KeyMaterial', () => {
    it('should return 32-byte key material', () => {
      const result = deriveEd25519KeyMaterial(testPrivateKey);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it('should be deterministic (same input -> same output)', () => {
      const result1 = deriveEd25519KeyMaterial(testPrivateKey);
      const result2 = deriveEd25519KeyMaterial(testPrivateKey);
      expect(result1).toEqual(result2);
    });

    it('should produce different output for different private keys', () => {
      const otherKey = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const result1 = deriveEd25519KeyMaterial(testPrivateKey);
      const result2 = deriveEd25519KeyMaterial(otherKey);
      expect(result1).not.toEqual(result2);
    });

    it('should produce different output with different info strings', () => {
      const result1 = deriveEd25519KeyMaterial(testPrivateKey, IPNS_HKDF_INFO);
      const result2 = deriveEd25519KeyMaterial(testPrivateKey, 'different-info');
      expect(result1).not.toEqual(result2);
    });

    it('should use the correct default HKDF info string', () => {
      expect(IPNS_HKDF_INFO).toBe('ipfs-storage-ed25519-v1');
    });

    it('should produce non-zero key material', () => {
      const result = deriveEd25519KeyMaterial(testPrivateKey);
      const allZero = result.every((b) => b === 0);
      expect(allZero).toBe(false);
    });
  });
});
