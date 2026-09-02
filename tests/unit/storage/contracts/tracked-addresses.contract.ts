/**
 * The `StorageProvider.saveTrackedAddresses` contract (#766 item 5).
 *
 * A wholesale write is a LOST UPDATE: every Sphere over one storage holds its own
 * snapshot of the tracked-address registry and persists all of it, so a writer whose
 * snapshot predates another's activation erases that address while the other Sphere
 * still reports it. The port docstring states the rule; every implementation must obey
 * it, and each keeps its own copy of the read-merge-write, so proving it for one
 * provider proves nothing about the other two.
 *
 * Run this against a provider with `describeTrackedAddressesContract` — see
 * tests/unit/storage/tracked-addresses-providers.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';

import type { StorageProvider } from '../../../../storage';
import type { TrackedAddressEntry } from '../../../../types';

export interface TrackedAddressesHarness {
  provider: StorageProvider;
  /** Release the backing store (temp dir, IDB connection, …). */
  cleanup?: () => Promise<void> | void;
}

function entry(index: number, over: Partial<TrackedAddressEntry> = {}): TrackedAddressEntry {
  return { index, hidden: false, createdAt: 1_000, updatedAt: 1_000, ...over };
}

const indices = (entries: readonly TrackedAddressEntry[]): number[] => entries.map((e) => e.index);

export function describeTrackedAddressesContract(
  name: string,
  makeHarness: () => TrackedAddressesHarness | Promise<TrackedAddressesHarness>
): void {
  describe(`saveTrackedAddresses contract: ${name}`, () => {
    async function withProvider(
      body: (provider: StorageProvider) => Promise<void>
    ): Promise<void> {
      const harness = await makeHarness();
      try {
        await body(harness.provider);
      } finally {
        await harness.cleanup?.();
      }
    }

    it('merges the writer snapshot into the stored registry instead of replacing it', async () => {
      await withProvider(async (provider) => {
        await provider.saveTrackedAddresses([entry(0), entry(1)]);
        // A second Sphere's snapshot, which never saw index 1. Replacing loses it.
        await provider.saveTrackedAddresses([entry(0), entry(2)]);

        expect(indices(await provider.loadTrackedAddresses())).toEqual([0, 1, 2]);
      });
    });

    it('resolves a conflicting index by the greater updatedAt, keeping the earlier createdAt', async () => {
      await withProvider(async (provider) => {
        await provider.saveTrackedAddresses([entry(1, { hidden: true, createdAt: 300, updatedAt: 900 })]);
        // Stale writer: it still believes index 1 is visible, on an older timestamp.
        await provider.saveTrackedAddresses([entry(1, { hidden: false, createdAt: 250, updatedAt: 400 })]);

        expect(await provider.loadTrackedAddresses()).toEqual([
          { index: 1, hidden: true, createdAt: 250, updatedAt: 900 },
        ]);
      });
    });

    it('serializes concurrent calls, so one call read cannot interleave with another write', async () => {
      await withProvider(async (provider) => {
        await Promise.all([
          provider.saveTrackedAddresses([entry(0), entry(1)]),
          provider.saveTrackedAddresses([entry(0), entry(2)]),
          provider.saveTrackedAddresses([entry(0), entry(3)]),
        ]);

        expect(indices(await provider.loadTrackedAddresses())).toEqual([0, 1, 2, 3]);
      });
    });

    it('a failed write rejects to its own caller and does not brick later writes', async () => {
      await withProvider(async (provider) => {
        await provider.saveTrackedAddresses([entry(0), entry(1)]);

        // The serializing chain must not carry the rejection forward: every later write
        // would then reject without ever running, so one transient disk/IDB error would
        // freeze the registry for the life of the provider.
        const set = vi.spyOn(provider, 'set').mockRejectedValueOnce(new Error('backing store is full'));
        await expect(provider.saveTrackedAddresses([entry(2)])).rejects.toThrow('backing store is full');

        await provider.saveTrackedAddresses([entry(3)]);
        set.mockRestore();

        // The failed write stored nothing; the one after it merged as usual.
        expect(indices(await provider.loadTrackedAddresses())).toEqual([0, 1, 3]);
      });
    });
  });
}
