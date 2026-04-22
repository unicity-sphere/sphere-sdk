/**
 * Pending-version marker (T-B2, T-B7) — crash-safety scenarios B1–B11.
 *
 * SPEC §7.1.4–§7.1.6.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  readMarker,
  writeMarker,
  clearMarker,
  computeCidHash,
  resolvePublishVersion,
  DURABLE_STORAGE,
  FlagStore,
  AggregatorPointerErrorCode,
  MARKER_MAX_JUMP,
} from '../../../../profile/aggregator-pointer/index.js';

// ── Helpers ────────────────────────────────────────────────────────────────

function makeDurableStore() {
  const kv = new Map<string, string>();
  const base = {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => { kv.set(k, v); },
    remove: async (k: string) => { kv.delete(k); },
    has: async (k: string) => kv.has(k),
    keys: async () => [...kv.keys()],
    clear: async () => { kv.clear(); },
    setIdentity: () => {},
    saveTrackedAddresses: async () => {},
    loadTrackedAddresses: async () => [],
    initialize: async () => {},
    shutdown: async () => {},
    name: 'test',
    [DURABLE_STORAGE]: true as const,
  };
  return base;
}

const PUBKEY = '0a'.repeat(33);

function makeFlagStore() {
  return FlagStore.create(makeDurableStore() as never, PUBKEY);
}

const CID_A = new Uint8Array(32).fill(0xaa);
const CID_B = new Uint8Array(32).fill(0xbb);
const CID_C = new Uint8Array(32).fill(0xcc);

// ── Tests ──────────────────────────────────────────────────────────────────

describe('readMarker / writeMarker / clearMarker (T-B2)', () => {
  it('B1: readMarker returns null when no marker exists', async () => {
    const fs = makeFlagStore();
    expect(await readMarker(fs)).toBeNull();
  });

  it('B2: writeMarker + readMarker round-trip', async () => {
    const fs = makeFlagStore();
    await writeMarker(fs, 42, CID_A);
    const marker = await readMarker(fs);
    expect(marker).not.toBeNull();
    expect(marker!.v).toBe(42);
    expect(marker!.cidHash.length).toBe(32);
    // cidHash = SHA-256(CID_A) — verify deterministically.
    const expected = computeCidHash(CID_A);
    expect(Array.from(marker!.cidHash)).toEqual(Array.from(expected));
  });

  it('B3: clearMarker removes the marker', async () => {
    const fs = makeFlagStore();
    await writeMarker(fs, 1, CID_A);
    await clearMarker(fs);
    expect(await readMarker(fs)).toBeNull();
  });

  it('B4: writeMarker rejects cidBytes.length != 32', async () => {
    const fs = makeFlagStore();
    await expect(writeMarker(fs, 1, new Uint8Array(31))).rejects.toThrow(RangeError);
    await expect(writeMarker(fs, 1, new Uint8Array(33))).rejects.toThrow(RangeError);
    await expect(writeMarker(fs, 1, new Uint8Array(0))).rejects.toThrow(RangeError);
  });

  it('B5: readMarker throws MARKER_CORRUPT for invalid JSON', async () => {
    const fs = makeFlagStore();
    await (fs as unknown as { set(k: string, v: string): Promise<void> }).set('pending_version', 'not-json{{{');
    await expect(readMarker(fs)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.MARKER_CORRUPT,
    });
  });

  it('B6: readMarker throws MARKER_CORRUPT for missing cidHash field', async () => {
    const fs = makeFlagStore();
    await (fs as unknown as { set(k: string, v: string): Promise<void> }).set(
      'pending_version',
      JSON.stringify({ v: 1 }),
    );
    await expect(readMarker(fs)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.MARKER_CORRUPT,
    });
  });

  it('B7: readMarker throws MARKER_CORRUPT for cidHash wrong length', async () => {
    const fs = makeFlagStore();
    await (fs as unknown as { set(k: string, v: string): Promise<void> }).set(
      'pending_version',
      JSON.stringify({ v: 1, cidHash: 'deadbeef' }), // 8 chars, not 64
    );
    await expect(readMarker(fs)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.MARKER_CORRUPT,
    });
  });

  it('B8: computeCidHash is deterministic', () => {
    expect(Array.from(computeCidHash(CID_A))).toEqual(Array.from(computeCidHash(CID_A)));
  });

  it('B9: computeCidHash produces 32 bytes', () => {
    expect(computeCidHash(CID_B).length).toBe(32);
  });
});

describe('resolvePublishVersion (T-B2, H13)', () => {
  let fs: FlagStore;

  beforeEach(() => { fs = makeFlagStore(); });

  it('B10: no marker → v = currentLocalVersion + 1', async () => {
    const r = await resolvePublishVersion(fs, 5, CID_A);
    expect(r.v).toBe(6);
    expect(r.isIdempotentRetry).toBe(false);
    expect(r.wasCompacted).toBe(false);
  });

  it('H13 idempotent retry: same v, same cidHash → re-use v', async () => {
    // Simulate a crash after writeMarker(v=6) but before publish committed.
    await writeMarker(fs, 6, CID_A);
    const r = await resolvePublishVersion(fs, 5, CID_A);
    expect(r.v).toBe(6);
    expect(r.isIdempotentRetry).toBe(true);
    expect(r.wasCompacted).toBe(false);
  });

  it('rollback-safe bump: cidHash mismatch → v = currentLocal + 1', async () => {
    await writeMarker(fs, 6, CID_A);
    // Different CID being published now → rollback-safe.
    const r = await resolvePublishVersion(fs, 5, CID_B);
    expect(r.v).toBe(6); // still bumps to 6 (currentLocal+1)
    expect(r.isIdempotentRetry).toBe(false);
  });

  it('stale marker (v <= currentLocal) → compact + v = currentLocal + 1', async () => {
    await writeMarker(fs, 3, CID_C);
    const r = await resolvePublishVersion(fs, 5, CID_A);
    expect(r.v).toBe(6);
    expect(r.wasCompacted).toBe(true);
    // Marker should be cleared.
    expect(await readMarker(fs)).toBeNull();
  });

  it('B11: MARKER_MAX_JUMP exceeded → MARKER_CORRUPT', async () => {
    const bigV = 5 + MARKER_MAX_JUMP + 1;
    await writeMarker(fs, bigV, CID_A);
    await expect(resolvePublishVersion(fs, 5, CID_A)).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.MARKER_CORRUPT,
    });
  });

  it('MARKER_MAX_JUMP exactly → does NOT throw (boundary)', async () => {
    const boundaryV = 5 + MARKER_MAX_JUMP;
    await writeMarker(fs, boundaryV, CID_A);
    // cidHash mismatch → rollback-safe bump (not idempotent), but not CORRUPT
    const r = await resolvePublishVersion(fs, 5, CID_B);
    expect(r.v).toBe(6);
  });
});
