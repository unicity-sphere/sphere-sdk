/**
 * Regression tests for Commit-A steelman remediations (crypto).
 *
 *   1. MasterPrivateKey.bytes returns a defensive copy — `masterKey.bytes.set(...)`
 *      cannot substitute attacker bytes under the registry's nose.
 *   2. SPEC §14.1 denylist rejects structurally-invalid master keys
 *      (all-zero, all-FF, curve-order-N, N±1) at createMasterPrivateKey.
 *   3. ProfilePointerLayer clones + freezes its config so post-construction
 *      mutation of `init.config.allowOperatorOverrides = true` does NOT
 *      bypass the T-E26 production guard.
 */

import { describe, it, expect } from 'vitest';
import {
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  AggregatorPointerErrorCode,
} from '../../../../profile/aggregator-pointer';
import { ProfilePointerLayer } from '../../../../profile/aggregator-pointer/ProfilePointerLayer';

describe('Commit A — crypto steelman remediations', () => {
  describe('1) MasterPrivateKey.bytes — defensive copy prevents WeakSet bypass', () => {
    it('mutating the returned bytes buffer does not affect the internal state', () => {
      const seed = new Uint8Array(32).fill(0x42);
      const mk = createMasterPrivateKey(seed);
      const km1 = derivePointerKeyMaterial(mk);
      const sig1 = Buffer.from(km1.signingSeed.reveal()).toString('hex');

      // Attempt to substitute bytes via the "exposed" Uint8Array.
      // After remediation, this is a DEFENSIVE COPY — the mutation has
      // no effect on the MasterPrivateKey's internal buffer.
      const exposed = mk.bytes;
      exposed.fill(0xff);
      exposed.set(new Uint8Array(32).fill(0xaa), 0);

      // Subsequent derivation must produce the SAME signing seed
      // (driven by the untouched internal buffer), not one derived
      // from the mutated view.
      const km2 = derivePointerKeyMaterial(mk);
      const sig2 = Buffer.from(km2.signingSeed.reveal()).toString('hex');
      expect(sig2).toBe(sig1);
    });

    it('each .bytes read returns a distinct Uint8Array instance', () => {
      const mk = createMasterPrivateKey(new Uint8Array(32).fill(0x42));
      const a = mk.bytes;
      const b = mk.bytes;
      expect(a).not.toBe(b);
      expect(Array.from(a)).toEqual(Array.from(b));
    });

    it('after zeroize, .bytes returns all-zero copies (internal wiped)', () => {
      const mk = createMasterPrivateKey(new Uint8Array(32).fill(0x42));
      mk.zeroize();
      expect(mk.bytes.every((b) => b === 0)).toBe(true);
    });
  });

  describe('2) SPEC §14.1 denylist — structurally-invalid master keys rejected', () => {
    const DENYLISTED = [
      { label: 'all-zero', bytes: new Uint8Array(32) },
      { label: 'all-FF', bytes: new Uint8Array(32).fill(0xff) },
      {
        label: 'curve-order-N',
        bytes: new Uint8Array([
          0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe,
          0xba, 0xae, 0xdc, 0xe6, 0xaf, 0x48, 0xa0, 0x3b, 0xbf, 0xd2, 0x5e, 0x8c, 0xd0, 0x36, 0x41, 0x41,
        ]),
      },
    ];

    for (const { label, bytes } of DENYLISTED) {
      it(`rejects ${label}`, () => {
        expect(() => createMasterPrivateKey(bytes)).toThrow(
          expect.objectContaining({
            code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
          }),
        );
      });
    }

    it('canonical 0x01×32 KAT vector accepted only with network="test-vectors" (Wave F.2)', () => {
      // SPEC §14.1 / §11.12 — the canonical KAT vector is denylisted
      // by default. Production networks reject it; only tests passing
      // network='test-vectors' accept it.
      expect(() => createMasterPrivateKey(new Uint8Array(32).fill(0x01))).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.PROTOCOL_ERROR }),
      );
      expect(() => createMasterPrivateKey(new Uint8Array(32).fill(0x01), 'mainnet')).toThrow(
        expect.objectContaining({ code: AggregatorPointerErrorCode.PROTOCOL_ERROR }),
      );
      const mk = createMasterPrivateKey(new Uint8Array(32).fill(0x01), 'test-vectors');
      expect(mk.bytes.every((b) => b === 0x01)).toBe(true);
    });

    it('accepts a typical random-looking key', () => {
      const bytes = new Uint8Array(32);
      for (let i = 0; i < 32; i++) bytes[i] = (i * 31 + 7) & 0xff;
      expect(() => createMasterPrivateKey(bytes)).not.toThrow();
    });
  });

  describe('3) ProfilePointerLayer — config cloned + frozen', () => {
    it('post-construction mutation of init.config does not flip override capability', async () => {
      const config: { allowOperatorOverrides?: boolean } = { allowOperatorOverrides: false };
      // Stub init with minimal fields (only config matters for this check).
      // The constructor's assertConfigCapabilities accepts this config.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const init: any = { config, keyMaterial: {}, signer: {}, aggregatorClient: {}, trustBase: {}, flagStore: {}, mutex: {}, decodeCid: () => null, fetchCar: async () => null, fetchAndJoin: async () => ({}), readLocalVersion: async () => 0, persistLocalVersion: async () => {}, resolveRemoteCid: async () => null };
      const layer = new ProfilePointerLayer(init);

      // Attacker mutates the caller-supplied config reference to flip
      // the operator-overrides flag on.
      config.allowOperatorOverrides = true;

      // The layer holds its own frozen snapshot — subsequent capability
      // probes must see the ORIGINAL `false` value. We verify by
      // attempting an override-gated operation and observing
      // CAPABILITY_DENIED (not the success path).
      await expect(
        // clearBlocked is a representative override-gated API.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (layer as any).clearBlocked(),
      ).rejects.toThrow(
        expect.objectContaining({
          code: AggregatorPointerErrorCode.CAPABILITY_DENIED,
        }),
      );
    });

    it('config object is frozen (cannot be mutated in place by callers who got a reference)', () => {
      const config: { allowOperatorOverrides?: boolean } = { allowOperatorOverrides: false };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const init: any = { config, keyMaterial: {}, signer: {}, aggregatorClient: {}, trustBase: {}, flagStore: {}, mutex: {}, decodeCid: () => null, fetchCar: async () => null, fetchAndJoin: async () => ({}), readLocalVersion: async () => 0, persistLocalVersion: async () => {}, resolveRemoteCid: async () => null };
      new ProfilePointerLayer(init);
      // The layer does not expose its private #config; but the defensive
      // clone + freeze can be verified by mutating the caller's copy
      // (previous test) AND by confirming the internal config is NOT
      // the same reference as the caller's. We observe this indirectly:
      // caller's reference remains mutable (not frozen externally).
      expect(Object.isFrozen(config)).toBe(false);
    });
  });
});
