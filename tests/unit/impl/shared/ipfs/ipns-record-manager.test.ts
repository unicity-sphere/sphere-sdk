import { describe, it, expect } from 'vitest';
import { verifySequenceProgression } from '../../../../../impl/shared/ipfs/ipns-record-manager';

describe('IPNS Record Manager', () => {
  describe('verifySequenceProgression', () => {
    it('should accept higher sequence number', () => {
      expect(verifySequenceProgression(2n, 1n)).toBe(true);
    });

    it('should reject same sequence number', () => {
      expect(verifySequenceProgression(1n, 1n)).toBe(false);
    });

    it('should reject lower sequence number', () => {
      expect(verifySequenceProgression(1n, 2n)).toBe(false);
    });

    it('should handle zero as last known', () => {
      expect(verifySequenceProgression(1n, 0n)).toBe(true);
    });

    it('should handle large sequence numbers', () => {
      const large = BigInt('999999999999999999');
      expect(verifySequenceProgression(large + 1n, large)).toBe(true);
      expect(verifySequenceProgression(large, large + 1n)).toBe(false);
    });
  });
});
