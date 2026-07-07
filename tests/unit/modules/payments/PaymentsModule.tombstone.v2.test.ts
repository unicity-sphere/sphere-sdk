/**
 * PaymentsModule tombstone tracking — Phase 6 v2 slim rebuild coverage.
 *
 * v2 slim keeps a `tombstones: TombstoneEntry[]` array so sync can converge
 * on remote peers (removing what's been deleted here). Public surface:
 *
 *   - `removeToken(id)` → deletes from wallet + pushes a tombstone.
 *   - `getTombstones()` → defensive copy of the internal array.
 *   - `isStateTombstoned(tokenId, stateHash)` → membership test.
 *   - `mergeTombstones(remote)` → dedup-append remote tombstones, returns
 *     how many were newly added.
 *   - `pruneTombstones()` → v2 slim no-op; retained for API stability.
 *   - Tombstones ride the storage-provider payload under `_tombstones`.
 *
 * Wave 6-P2-5 quarantined the v1 tombstone tests; this suite locks in the
 * slim contract on the paths only reachable through public methods.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
      getSymbol: (id: string) => id,
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  makeV2Harness,
  mint,
  resetTokenSeq,
} from './__fixtures__/v2-harness';
import type { TombstoneEntry } from '../../../../types/txf';

describe('PaymentsModule tombstones (v2 slim)', () => {
  beforeEach(() => {
    resetTokenSeq();
  });

  it('removeToken() drops the token from getTokens() AND records a tombstone', async () => {
    const h = await makeV2Harness();
    const t = await mint(h, 'UCT', 100n);
    expect(h.module.getTokens()).toHaveLength(1);

    await h.module.removeToken(t.id);

    expect(h.module.getTokens()).toHaveLength(0);
    const tombstones = h.module.getTombstones();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].tokenId).toBe(t.id);
    expect(typeof tombstones[0].timestamp).toBe('number');
  });

  it('multiple removes accumulate tombstones (one per removed token)', async () => {
    const h = await makeV2Harness();
    const a = await mint(h, 'UCT', 100n);
    const b = await mint(h, 'UCT', 200n);
    const c = await mint(h, 'USDU', 500n);

    await h.module.removeToken(a.id);
    await h.module.removeToken(b.id);
    await h.module.removeToken(c.id);

    const tombstones = h.module.getTombstones();
    expect(tombstones).toHaveLength(3);
    const ids = tombstones.map((t) => t.tokenId).sort();
    expect(ids).toEqual([a.id, b.id, c.id].sort());
  });

  it('removing an unknown tokenId does NOT push a tombstone', async () => {
    const h = await makeV2Harness();
    await h.module.removeToken('does-not-exist');
    expect(h.module.getTombstones()).toHaveLength(0);
  });

  it('getTombstones() returns a defensive copy', async () => {
    const h = await makeV2Harness();
    const t = await mint(h, 'UCT', 100n);
    await h.module.removeToken(t.id);

    const copy = h.module.getTombstones();
    expect(copy).toHaveLength(1);
    copy.length = 0;
    // Underlying list unchanged.
    expect(h.module.getTombstones()).toHaveLength(1);
  });

  it('isStateTombstoned() returns true for a recorded (tokenId, stateHash) pair, false otherwise', async () => {
    const h = await makeV2Harness();
    const t = await mint(h, 'UCT', 100n);
    await h.module.removeToken(t.id);
    // removeTokenLocal writes stateHash: '' — so isStateTombstoned('') matches.
    expect(h.module.isStateTombstoned(t.id, '')).toBe(true);
    // A different stateHash for the same tokenId does NOT match.
    expect(h.module.isStateTombstoned(t.id, 'other-hash')).toBe(false);
    // Unknown tokenId → false.
    expect(h.module.isStateTombstoned('other-id', '')).toBe(false);
  });

  it('mergeTombstones() dedups by (tokenId, stateHash) and returns the count of NEW entries', async () => {
    const h = await makeV2Harness();
    const t1 = await mint(h, 'UCT', 100n);
    await h.module.removeToken(t1.id);

    const remote: TombstoneEntry[] = [
      // Duplicate (already tombstoned by removeToken).
      { tokenId: t1.id, stateHash: '', timestamp: Date.now() },
      // Same tokenId, different stateHash → new.
      { tokenId: t1.id, stateHash: 'h2', timestamp: Date.now() },
      // Different tokenId → new.
      { tokenId: 'remote-1', stateHash: 'r1', timestamp: Date.now() },
      // Different tokenId → new.
      { tokenId: 'remote-2', stateHash: 'r2', timestamp: Date.now() },
    ];

    const added = await h.module.mergeTombstones(remote);
    expect(added).toBe(3);
    expect(h.module.getTombstones()).toHaveLength(4);
  });

  it('mergeTombstones() on an empty remote is a no-op that returns 0', async () => {
    const h = await makeV2Harness();
    const added = await h.module.mergeTombstones([]);
    expect(added).toBe(0);
    expect(h.module.getTombstones()).toHaveLength(0);
  });

  it('pruneTombstones() is a no-op in v2 slim (does NOT remove entries)', async () => {
    const h = await makeV2Harness();
    const t = await mint(h, 'UCT', 100n);
    await h.module.removeToken(t.id);
    expect(h.module.getTombstones()).toHaveLength(1);

    await h.module.pruneTombstones();
    expect(h.module.getTombstones()).toHaveLength(1);
  });

  it('storage payload carries _tombstones after removeToken()', async () => {
    const h = await makeV2Harness();
    const t = await mint(h, 'UCT', 100n);
    await h.module.removeToken(t.id);

    const last = h.storage.saved[h.storage.saved.length - 1];
    expect(Array.isArray(last._tombstones)).toBe(true);
    expect(last._tombstones!.length).toBe(1);
    expect(last._tombstones![0].tokenId).toBe(t.id);
  });

  it('tombstones survive a load/save round-trip via persistAll → loadFromStorageData', async () => {
    const h1 = await makeV2Harness();
    const t = await mint(h1, 'UCT', 100n);
    await h1.module.removeToken(t.id);
    const saved = h1.storage.saved[h1.storage.saved.length - 1];

    const h2 = await makeV2Harness({ initialStorageData: saved });
    const tombstones = h2.module.getTombstones();
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].tokenId).toBe(t.id);
  });

  it('mergeTombstones on new data triggers persistAll (storage save called)', async () => {
    const h = await makeV2Harness();
    const savedBefore = h.storage.saved.length;
    await h.module.mergeTombstones([
      { tokenId: 'remote-x', stateHash: 'sx', timestamp: Date.now() },
    ]);
    expect(h.storage.saved.length).toBeGreaterThan(savedBefore);
  });
});
