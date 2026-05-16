/**
 * Shared helper: spy on `Sphere.prototype.mintNametag` with a realistic
 * stub that also persists the nametag to `_payments.setNametag` — matching
 * what the real `mintNametag` does on success.
 *
 * Why this matters. The nametag-mint/Nostr-binding consistency fix added
 * a belt-and-braces guard in `Sphere.registerNametag`: it verifies that
 * after `mintNametag` reports success, the wallet's nametag store
 * actually holds a token for the requested name. A naive mock that
 * returns `{ success: true, nametagData: null }` without populating the
 * store now correctly trips that guard (no on-chain token → can't
 * advertise on Nostr). Tests that simulate a successful mint need to
 * simulate the persistence side too.
 *
 * Consumers (in `beforeEach` after creating the sphere instance or in
 * the test body before calling `registerNametag`):
 *
 *     const spy = mockMintNametagSuccess();
 *     // ... await sphere.registerNametag('alice');
 *     spy.mockRestore();
 *
 * For failure simulation, use the real `vi.spyOn(...).mockResolvedValue(
 * { success: false, error: '...' })` form — no store side-effect needed.
 */
import { vi } from 'vitest';
import { Sphere } from '../../core/Sphere';
import type { NametagData } from '../../types/txf';

interface SphereInternals {
  _payments: {
    setNametag(data: NametagData): Promise<void>;
  };
}

/**
 * Install a spy on `Sphere.prototype.mintNametag` that simulates a
 * successful aggregator mint AND persists the nametag to PaymentsModule.
 */
export function mockMintNametagSuccess(): ReturnType<typeof vi.spyOn> {
  return vi
    .spyOn(
      Sphere.prototype as unknown as {
        mintNametag: (n: string) => Promise<unknown>;
      },
      'mintNametag',
    )
    .mockImplementation(async function (this: SphereInternals, name: string) {
      const data: NametagData = {
        name,
        token: { id: `${name}-mock-token-id` },
        timestamp: Date.now(),
        format: 'txf',
        version: '2.0',
      };
      await this._payments.setNametag(data);
      return { success: true, token: null, nametagData: data };
    });
}
