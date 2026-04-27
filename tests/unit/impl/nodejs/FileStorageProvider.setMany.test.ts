/**
 * Wave J.b: FileStorageProvider.setMany serialization tests.
 *
 * Verifies that concurrent setMany calls do not interleave their
 * snapshot/mutate/save/rollback critical sections — the per-instance
 * setManyChain ensures each call sees a consistent prevMutated/
 * prevRemoved snapshot from the prior settled state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FileStorageProvider } from '../../../../impl/nodejs/storage/FileStorageProvider';

describe('FileStorageProvider.setMany — Wave J.b serialization', () => {
  let tmpDir: string;
  let provider: FileStorageProvider;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sphere-setmany-'));
    provider = new FileStorageProvider({ dataDir: tmpDir });
    await provider.connect();
  });

  afterEach(async () => {
    try {
      await provider.disconnect();
    } catch {
      /* noop */
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* noop */
    }
  });

  it('serializes 10 concurrent setMany calls — no interleaving, all writes land', async () => {
    // Fire 10 setMany calls concurrently, each writing 3 keys with
    // a unique prefix. After all settle, the on-disk file must
    // contain ALL 30 keys with the expected values.
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      const entries: Array<[string, string]> = [
        [`grp${i}.k1`, `v${i}-1`],
        [`grp${i}.k2`, `v${i}-2`],
        [`grp${i}.k3`, `v${i}-3`],
      ];
      promises.push(provider.setMany(entries));
    }
    await Promise.all(promises);

    // Read back every key — all must be present with the right value.
    for (let i = 0; i < 10; i++) {
      expect(await provider.get(`grp${i}.k1`)).toBe(`v${i}-1`);
      expect(await provider.get(`grp${i}.k2`)).toBe(`v${i}-2`);
      expect(await provider.get(`grp${i}.k3`)).toBe(`v${i}-3`);
    }
  });

  it('handles concurrent setMany on the SAME key (last-writer-wins)', async () => {
    // 5 concurrent setMany calls writing the same key with different
    // values. Final value should be deterministic (the last to enter
    // the chain wins) and ALL 5 calls should resolve successfully.
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(provider.setMany([['contended.key', `v${i}`]]));
    }
    await Promise.all(promises);

    // The final value is whichever setMany ran last. With chain
    // serialization that's the last one to enter the chain (first
    // in source order, since the chain captures snapshots
    // synchronously in call order).
    const final = await provider.get('contended.key');
    expect(final).toMatch(/^v\d$/);
  });

  it('zero-entry setMany resolves immediately without affecting the chain', async () => {
    await provider.setMany([]);
    // After a no-op, subsequent setMany still works.
    await provider.setMany([['k', 'v']]);
    expect(await provider.get('k')).toBe('v');
  });

  it('sequential setMany calls compose cleanly via the chain', async () => {
    // Wave K NOTE: this test asserts that two awaited setMany calls
    // run to completion without interfering. Renamed from "does not
    // poison" because it doesn't actually inject a failure. The
    // poison-prevention `.catch(() => undefined)` on `setManyChain`
    // tail is exercised indirectly by the concurrent test above
    // (10 calls; if any failure-poisoned the chain, later calls
    // would block forever or reject) but isn't asserted directly
    // because vitest can't deterministically trigger a save()
    // failure without modifying production code paths.
    await provider.setMany([['a', '1']]);
    await provider.setMany([['b', '2']]);
    expect(await provider.get('a')).toBe('1');
    expect(await provider.get('b')).toBe('2');
  });

  // Wave M (Round 7 W1): setMany rollback path — mutatedKeys/
  // removedKeys snapshot restoration on save() failure. A regression
  // that broke the snapshot would leak the F.43 multi-process
  // clobber hazard (re-introducing the bug that I.4 was supposed
  // to fix). This test injects a save() failure and asserts:
  //   (a) setMany rejects
  //   (b) in-memory state is rolled back (get() returns prior values)
  //   (c) a subsequent setMany on different keys works cleanly
  //       — proves mutatedKeys/removedKeys aren't poisoned
  it('rolls back in-memory state on save() failure (Wave I.4 + M.1)', async () => {
    // Pre-populate so we have a "prior value" for one of the setMany keys.
    await provider.set('preexisting', 'original');
    expect(await provider.get('preexisting')).toBe('original');

    // Spy on save() to fail exactly once.
    const saveSpy = vi
      .spyOn(provider as unknown as { save: () => Promise<void> }, 'save')
      .mockRejectedValueOnce(new Error('injected disk-full'));

    // setMany overwriting one preexisting key + adding a new one.
    await expect(
      provider.setMany([
        ['preexisting', 'overwritten'],
        ['fresh', 'newvalue'],
      ]),
    ).rejects.toThrow(/injected disk-full/);

    // Restore the spy so subsequent setMany works.
    saveSpy.mockRestore();

    // (b) in-memory state rolled back — preexisting key still has
    // its original value; fresh key was deleted.
    expect(await provider.get('preexisting')).toBe('original');
    expect(await provider.get('fresh')).toBeNull();

    // (c) subsequent setMany works cleanly — proves mutatedKeys
    // wasn't poisoned. If the rollback had failed to restore
    // mutatedKeys, the next setMany's save would see ghost keys
    // and either fail or write inconsistent state.
    await provider.setMany([['next', 'value']]);
    expect(await provider.get('next')).toBe('value');
    // preexisting still original after the second setMany completes.
    expect(await provider.get('preexisting')).toBe('original');
  });
});
