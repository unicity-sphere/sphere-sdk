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
 * The same lost update exists one level up, BETWEEN provider objects: `backingStoreId`
 * explicitly permits two providers over one store, and a per-object lock does not order
 * them. `crossObject` is where each implementation states whether it closes that.
 *
 * Run this against a provider with `describeTrackedAddressesContract` — see
 * tests/unit/storage/tracked-addresses-providers.test.ts.
 */
import { describe, expect, it } from 'vitest';

import type { StorageProvider } from '../../../../storage';
import type { TrackedAddressEntry } from '../../../../types';

export interface TrackedAddressesHarness {
  provider: StorageProvider;
  /**
   * Arm a ONE-SHOT failure of the next tracked-address persist, the way this
   * implementation actually fails (a rejecting write, a refused transaction).
   */
  failNextWrite: (message: string) => void;
  /**
   * Build a SECOND provider object over the SAME backing store. Required when
   * `crossObject` is true; the harness releases it in `cleanup`.
   */
  sibling?: () => Promise<StorageProvider>;
  /** Release the backing store (temp dir, IDB connections, …). */
  cleanup?: () => Promise<void> | void;
}

export interface TrackedAddressesContractOptions {
  /**
   * `true` when two provider objects over one backing store must not lose each other's
   * entries — the harness must then supply `sibling`. Otherwise the reason this
   * implementation cannot hold that, so an uncovered provider reads as a stated
   * decision rather than an oversight.
   */
  crossObject: true | { unsupported: string };
}

function entry(index: number, over: Partial<TrackedAddressEntry> = {}): TrackedAddressEntry {
  return { index, hidden: false, createdAt: 1_000, updatedAt: 1_000, ...over };
}

const indices = (entries: readonly TrackedAddressEntry[]): number[] => entries.map((e) => e.index);

export function describeTrackedAddressesContract(
  name: string,
  makeHarness: () => TrackedAddressesHarness | Promise<TrackedAddressesHarness>,
  options: TrackedAddressesContractOptions
): void {
  describe(`saveTrackedAddresses contract: ${name}`, () => {
    async function withHarness(
      body: (harness: TrackedAddressesHarness) => Promise<void>
    ): Promise<void> {
      const harness = await makeHarness();
      try {
        await body(harness);
      } finally {
        await harness.cleanup?.();
      }
    }

    async function withProvider(
      body: (provider: StorageProvider) => Promise<void>
    ): Promise<void> {
      await withHarness((harness) => body(harness.provider));
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
      await withHarness(async ({ provider, failNextWrite }) => {
        await provider.saveTrackedAddresses([entry(0), entry(1)]);

        // The serializing chain must not carry the rejection forward: every later write
        // would then reject without ever running, so one transient disk/IDB error would
        // freeze the registry for the life of the provider.
        failNextWrite('backing store is full');
        await expect(provider.saveTrackedAddresses([entry(2)])).rejects.toThrow('backing store is full');

        await provider.saveTrackedAddresses([entry(3)]);

        // The failed write stored nothing; the one after it merged as usual.
        expect(indices(await provider.loadTrackedAddresses())).toEqual([0, 1, 3]);
      });
    });

    it('rejects a registry it cannot serialize rather than reporting a write it never made', async () => {
      await withProvider(async (provider) => {
        await provider.saveTrackedAddresses([entry(0)]);
        // A BigInt cannot be JSON-serialized. Whatever throws mid-write, the caller must
        // hear about it: a resolved save that stored nothing is the failure mode a
        // read-merge-write inside a transaction can produce and a plain one cannot.
        const unserializable = { ...entry(1), label: 1n } as unknown as TrackedAddressEntry;
        await expect(provider.saveTrackedAddresses([unserializable])).rejects.toThrow();

        expect(indices(await provider.loadTrackedAddresses())).toEqual([0]);
        await provider.saveTrackedAddresses([entry(2)]);
        expect(indices(await provider.loadTrackedAddresses())).toEqual([0, 2]);
      });
    });

    it('refuses an underivable index instead of storing a row the next load drops', async () => {
      await withProvider(async (provider) => {
        await provider.saveTrackedAddresses([entry(0)]);

        // `1.5` derives index 1's keys (the path segment is parseInt()ed), so a stored row
        // aliases a real address. Enforced only on read, this save reported success and the
        // next load silently dropped the address the caller believes it activated.
        const underivable = { ...entry(0), index: 1.5 } as TrackedAddressEntry;
        await expect(provider.saveTrackedAddresses([entry(2), underivable])).rejects.toThrow();

        // Nothing from the refused call landed — not even its well-formed companion.
        expect(indices(await provider.loadTrackedAddresses())).toEqual([0]);
        await provider.saveTrackedAddresses([entry(1)]);
        expect(indices(await provider.loadTrackedAddresses())).toEqual([0, 1]);
      });
    });

    if (options.crossObject !== true) return;

    it('merges across SEPARATE provider objects over the same backing store', async () => {
      await withHarness(async ({ provider, sibling }) => {
        if (!sibling) throw new Error('crossObject providers must supply a sibling factory');
        const second = await sibling();
        const third = await sibling();

        // Three objects, three disjoint snapshots, no awaiting between them. Per-object
        // serialization lets all three read the empty registry and the last write wins.
        await Promise.all([
          provider.saveTrackedAddresses([entry(0), entry(1)]),
          second.saveTrackedAddresses([entry(0), entry(2)]),
          third.saveTrackedAddresses([entry(0), entry(3)]),
        ]);

        for (const reader of [provider, second, third]) {
          expect(indices(await reader.loadTrackedAddresses())).toEqual([0, 1, 2, 3]);
        }
      });
    });

    it('keeps serializing separate objects after an earlier round has settled', async () => {
      await withHarness(async ({ provider, sibling }) => {
        if (!sibling) throw new Error('crossObject providers must supply a sibling factory');
        const second = await sibling();

        // A settled round may retire the shared coordination slot; the next round must
        // still be ordered rather than starting from a fresh, empty chain each time.
        await provider.saveTrackedAddresses([entry(0)]);
        await Promise.all([
          provider.saveTrackedAddresses([entry(1)]),
          second.saveTrackedAddresses([entry(2)]),
        ]);

        expect(indices(await second.loadTrackedAddresses())).toEqual([0, 1, 2]);
      });
    });
  });
}
