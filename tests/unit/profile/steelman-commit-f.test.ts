/**
 * Regression tests for Commit-F (steelman² hardening) remediations.
 *
 *   1. Master-key denylist uses byte-comparison, not hex-string Set.
 *      Verifies behavior parity (denylisted entries still rejected).
 *
 *   2. ProfilePointerLayer config normalization rejects truthy
 *      non-boolean values (`'yes'`, `1`) for the override flags.
 */

import { describe, it, expect } from 'vitest';
import {
  createMasterPrivateKey,
  AggregatorPointerErrorCode,
} from '../../../profile/aggregator-pointer';
import { ProfilePointerLayer } from '../../../profile/aggregator-pointer/ProfilePointerLayer';

describe('Commit F — steelman² hardening regressions', () => {
  describe('1) byte-compare denylist (no hex-string heap residue)', () => {
    it('still rejects all-zero', () => {
      expect(() => createMasterPrivateKey(new Uint8Array(32))).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.PROTOCOL_ERROR }),
      );
    });
    it('still rejects all-FF', () => {
      expect(() => createMasterPrivateKey(new Uint8Array(32).fill(0xff))).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.PROTOCOL_ERROR }),
      );
    });
    it('still rejects curve-order N', () => {
      const N = new Uint8Array([
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
        0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
        0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b,
        0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
      ]);
      expect(() => createMasterPrivateKey(N)).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.PROTOCOL_ERROR }),
      );
    });
    it('canonical 0x01×32 KAT vector still allowed', () => {
      const mk = createMasterPrivateKey(new Uint8Array(32).fill(0x01));
      expect(mk.bytes.every((b) => b === 0x01)).toBe(true);
    });
    it('typical random key still allowed', () => {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) bytes[i] = (i * 31 + 7) & 0xff;
      expect(() => createMasterPrivateKey(bytes)).not.toThrow();
    });
  });

  describe('2) config normalization rejects truthy non-boolean values', () => {
    it('treats `allowOperatorOverrides: "yes"` as false (not the truthy sense)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const init: any = {
        config: { allowOperatorOverrides: 'yes' },
        keyMaterial: {}, signer: {}, aggregatorClient: {}, trustBase: {},
        flagStore: {}, mutex: {}, decodeCid: () => null,
        fetchCar: async () => null, fetchAndJoin: async () => ({}),
        readLocalVersion: async () => 0, persistLocalVersion: async () => {},
        resolveRemoteCid: async () => null,
      };
      const layer = new ProfilePointerLayer(init);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (layer as any).clearBlocked(),
      ).rejects.toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.CAPABILITY_DENIED }),
      );
    });
    it('treats `allowOperatorOverrides: 1` as false', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const init: any = {
        config: { allowOperatorOverrides: 1 },
        keyMaterial: {}, signer: {}, aggregatorClient: {}, trustBase: {},
        flagStore: {}, mutex: {}, decodeCid: () => null,
        fetchCar: async () => null, fetchAndJoin: async () => ({}),
        readLocalVersion: async () => 0, persistLocalVersion: async () => {},
        resolveRemoteCid: async () => null,
      };
      const layer = new ProfilePointerLayer(init);
      await expect(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (layer as any).clearBlocked(),
      ).rejects.toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.CAPABILITY_DENIED }),
      );
    });
  });
});
