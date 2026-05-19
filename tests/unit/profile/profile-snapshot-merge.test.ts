/**
 * Unit tests for profile/profile-snapshot-merge.ts (Item #15 Phase B.1).
 *
 * Locks the shared CRDT primitive that all per-writer JOIN paths
 * delegate to. Covers:
 *
 *   - Every cell of the 6-row merge table.
 *   - Equal-Lamport tie-break behaviour (where the table specifies it
 *     and where it leaves local-wins implicit).
 *   - The runJoinSnapshot loop's idempotence, partial-failure
 *     handling, and counter accuracy.
 *   - validateLamport's bounds defence.
 *
 * The runner is exercised with synthetic in-memory deps so the test
 * does not depend on any OrbitDB or encryption-key wiring.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeSlots,
  runJoinSnapshot,
  validateLamport,
  MAX_SAFE_LAMPORT,
  type ClassifiedSlot,
  type SnapshotEntry,
  type JoinDeps,
} from '../../../profile/profile-snapshot-merge';

// =============================================================================
// 1. mergeSlots — every cell of the 6-row table + tie-breaks
// =============================================================================

describe('mergeSlots — Item #15 Phase B table', () => {
  // Row: absent + live → write remote (live)
  it('absent + live → write-remote (live)', () => {
    const action = mergeSlots(
      { kind: 'absent' },
      { kind: 'live', lamport: 5 },
    );
    expect(action.kind).toBe('write-remote');
    if (action.kind === 'write-remote') {
      expect(action.remoteKind).toBe('live');
    }
  });

  // Row: absent + tombstone → write remote (tombstone)
  it('absent + tombstone → write-remote (tombstone)', () => {
    const action = mergeSlots(
      { kind: 'absent' },
      { kind: 'tombstone', lamport: 3 },
    );
    expect(action.kind).toBe('write-remote');
    if (action.kind === 'write-remote') {
      expect(action.remoteKind).toBe('tombstone');
    }
  });

  // Row: live + live (remote higher) → write remote
  it('live + live (remote higher) → write-remote', () => {
    const action = mergeSlots(
      { kind: 'live', lamport: 5 },
      { kind: 'live', lamport: 7 },
    );
    expect(action.kind).toBe('write-remote');
    if (action.kind === 'write-remote') {
      expect(action.remoteKind).toBe('live');
    }
  });

  // Row: live + live (local higher) → no-op
  it('live + live (local higher) → noop', () => {
    const action = mergeSlots(
      { kind: 'live', lamport: 10 },
      { kind: 'live', lamport: 7 },
    );
    expect(action.kind).toBe('noop');
    if (action.kind === 'noop') {
      expect(action.reason).toBe('local-wins-lamport');
    }
  });

  // Row: live + live (equal) → no-op (tie-break favours local)
  it('live + live (equal lamport) → noop', () => {
    const action = mergeSlots(
      { kind: 'live', lamport: 5 },
      { kind: 'live', lamport: 5 },
    );
    expect(action.kind).toBe('noop');
  });

  // Row: live + tombstone (tomb ≥ live) → tombstone wins
  it('live + tombstone (tomb > live) → write-remote (tombstone)', () => {
    const action = mergeSlots(
      { kind: 'live', lamport: 3 },
      { kind: 'tombstone', lamport: 5 },
    );
    expect(action.kind).toBe('write-remote');
    if (action.kind === 'write-remote') {
      expect(action.remoteKind).toBe('tombstone');
    }
  });

  // Sticky-tombstone tie-break: live + tombstone (equal) → tombstone wins
  it('live + tombstone (equal lamport) → write-remote (tombstone)', () => {
    // The >= rule keeps tombstones sticky at ties — mirrors the existing
    // refuse-write guard at write time.
    const action = mergeSlots(
      { kind: 'live', lamport: 5 },
      { kind: 'tombstone', lamport: 5 },
    );
    expect(action.kind).toBe('write-remote');
    if (action.kind === 'write-remote') {
      expect(action.remoteKind).toBe('tombstone');
    }
  });

  // Row: live + tombstone (tomb < live) → local wins
  it('live + tombstone (tomb < live) → noop', () => {
    const action = mergeSlots(
      { kind: 'live', lamport: 10 },
      { kind: 'tombstone', lamport: 5 },
    );
    expect(action.kind).toBe('noop');
  });

  // Row: tombstone + live (live > tomb) → live wins (resurrection allowed)
  it('tombstone + live (live > tomb) → write-remote (live)', () => {
    const action = mergeSlots(
      { kind: 'tombstone', lamport: 3 },
      { kind: 'live', lamport: 7 },
    );
    expect(action.kind).toBe('write-remote');
    if (action.kind === 'write-remote') {
      expect(action.remoteKind).toBe('live');
    }
  });

  // Sticky-tombstone tie-break: tombstone + live (equal) → tombstone preserved
  it('tombstone + live (equal lamport) → noop (tombstone preserved)', () => {
    // Symmetric to the (live, tombstone, equal) case — the `>` rule
    // refuses resurrection at ties.
    const action = mergeSlots(
      { kind: 'tombstone', lamport: 5 },
      { kind: 'live', lamport: 5 },
    );
    expect(action.kind).toBe('noop');
  });

  // Row: tombstone + live (live < tomb) → tombstone preserved
  it('tombstone + live (live < tomb) → noop', () => {
    const action = mergeSlots(
      { kind: 'tombstone', lamport: 10 },
      { kind: 'live', lamport: 5 },
    );
    expect(action.kind).toBe('noop');
  });

  // Row: tombstone + tombstone (remote higher) → write remote
  it('tombstone + tombstone (remote higher) → write-remote', () => {
    const action = mergeSlots(
      { kind: 'tombstone', lamport: 3 },
      { kind: 'tombstone', lamport: 7 },
    );
    expect(action.kind).toBe('write-remote');
    if (action.kind === 'write-remote') {
      expect(action.remoteKind).toBe('tombstone');
    }
  });

  // Row: tombstone + tombstone (local higher) → no-op
  it('tombstone + tombstone (local higher) → noop', () => {
    const action = mergeSlots(
      { kind: 'tombstone', lamport: 10 },
      { kind: 'tombstone', lamport: 3 },
    );
    expect(action.kind).toBe('noop');
  });

  // Row: tombstone + tombstone (equal) → no-op
  it('tombstone + tombstone (equal) → noop', () => {
    const action = mergeSlots(
      { kind: 'tombstone', lamport: 5 },
      { kind: 'tombstone', lamport: 5 },
    );
    expect(action.kind).toBe('noop');
  });

  // Edge: remote absent → no-op
  it('any + absent → noop', () => {
    const a = mergeSlots({ kind: 'live', lamport: 5 }, { kind: 'absent' });
    expect(a.kind).toBe('noop');
    if (a.kind === 'noop') expect(a.reason).toBe('remote-absent');

    const b = mergeSlots({ kind: 'tombstone', lamport: 5 }, { kind: 'absent' });
    expect(b.kind).toBe('noop');
    if (b.kind === 'noop') expect(b.reason).toBe('remote-absent');

    const c = mergeSlots({ kind: 'absent' }, { kind: 'absent' });
    expect(c.kind).toBe('noop');
  });
});

// =============================================================================
// 2. validateLamport — bounds defence
// =============================================================================

describe('validateLamport — bounds defence', () => {
  it('accepts 0, 1, MAX_SAFE_LAMPORT', () => {
    expect(validateLamport(0)).toBe(0);
    expect(validateLamport(1)).toBe(1);
    expect(validateLamport(MAX_SAFE_LAMPORT)).toBe(MAX_SAFE_LAMPORT);
  });

  it('rejects negative / non-integer / NaN / Infinity / null / string', () => {
    expect(validateLamport(-1)).toBeNull();
    expect(validateLamport(1.5)).toBeNull();
    expect(validateLamport(Number.NaN)).toBeNull();
    expect(validateLamport(Number.POSITIVE_INFINITY)).toBeNull();
    expect(validateLamport(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(validateLamport(null)).toBeNull();
    expect(validateLamport(undefined)).toBeNull();
    expect(validateLamport('5')).toBeNull();
    expect(validateLamport({})).toBeNull();
  });

  it('rejects values above MAX_SAFE_LAMPORT (W39 bounds defence)', () => {
    expect(validateLamport(MAX_SAFE_LAMPORT + 1)).toBeNull();
    expect(validateLamport(Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

// =============================================================================
// 3. runJoinSnapshot — integration with synthetic deps
// =============================================================================

/**
 * Minimal in-memory KV double mimicking the writer's storage surface.
 * The classifier interprets entries as JSON-encoded:
 *   - `{ tombstoned: true, lamport: N }` → tombstone
 *   - `{ lamport: N, ... }` → live
 *   - missing key → absent
 * Bytes are NOT encrypted in the test — the merge layer doesn't care.
 */
class InMemoryKv {
  private readonly data = new Map<string, Uint8Array>();

  put(key: string, bytes: Uint8Array): void {
    this.data.set(key, bytes);
  }
  get(key: string): Uint8Array | undefined {
    return this.data.get(key);
  }
  has(key: string): boolean {
    return this.data.has(key);
  }
  snapshot(): SnapshotEntry[] {
    const out: SnapshotEntry[] = [];
    for (const [key, encryptedValue] of this.data) {
      out.push({ key, encryptedValue });
    }
    return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
}

function liveBytes(lamport: number, payload = ''): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ lamport, payload }));
}

function tombBytes(lamport: number): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ tombstoned: true, lamport, deletedAt: 1 }),
  );
}

function classifyBytes(bytes: Uint8Array): ClassifiedSlot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const p = parsed as Record<string, unknown>;
  const lamport = validateLamport(p.lamport);
  if (lamport === null) return null;
  if (p.tombstoned === true) {
    return { kind: 'tombstone', lamport };
  }
  return { kind: 'live', lamport };
}

function makeDeps(kv: InMemoryKv): JoinDeps {
  return {
    classifyLocal: async (key) => {
      const bytes = kv.get(key);
      if (bytes === undefined) return { kind: 'absent' };
      const slot = classifyBytes(bytes);
      return slot === null ? { kind: 'absent' } : slot;
    },
    classifyRemote: async (entry) => classifyBytes(entry.encryptedValue),
    writeRemote: async (key, bytes) => kv.put(key, bytes),
  };
}

describe('runJoinSnapshot — basic convergence', () => {
  it('writes remote when local is absent (mixed live + tombstone)', async () => {
    const local = new InMemoryKv();
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: liveBytes(5, 'r1') },
      { key: 'k2', encryptedValue: tombBytes(3) },
    ];
    const result = await runJoinSnapshot(remote, makeDeps(local));

    expect(result.entriesEvaluated).toBe(2);
    expect(result.liveLanded).toBe(1);
    expect(result.tombstonesLanded).toBe(1);
    expect(result.localWon).toBe(0);
    expect(result.remoteRejectedMalformed).toBe(0);
    expect(local.has('k1')).toBe(true);
    expect(local.has('k2')).toBe(true);
  });

  it('keeps local when local lamport is strictly higher (live + live)', async () => {
    const local = new InMemoryKv();
    local.put('k1', liveBytes(10, 'L'));
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: liveBytes(5, 'R') },
    ];
    const result = await runJoinSnapshot(remote, makeDeps(local));

    expect(result.liveLanded).toBe(0);
    expect(result.localWon).toBe(1);
    // Local payload preserved.
    const local1 = local.get('k1')!;
    expect(new TextDecoder().decode(local1)).toContain('"L"');
  });

  it('takes remote when remote lamport is strictly higher (live + live)', async () => {
    const local = new InMemoryKv();
    local.put('k1', liveBytes(3, 'L'));
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: liveBytes(7, 'R') },
    ];
    const result = await runJoinSnapshot(remote, makeDeps(local));

    expect(result.liveLanded).toBe(1);
    expect(result.localWon).toBe(0);
    const local1 = local.get('k1')!;
    expect(new TextDecoder().decode(local1)).toContain('"R"');
  });

  it('tombstone wins at equal lamport (live local + tombstone remote)', async () => {
    const local = new InMemoryKv();
    local.put('k1', liveBytes(5));
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: tombBytes(5) },
    ];
    const result = await runJoinSnapshot(remote, makeDeps(local));

    expect(result.tombstonesLanded).toBe(1);
    expect(result.localWon).toBe(0);
    const local1 = local.get('k1')!;
    expect(new TextDecoder().decode(local1)).toContain('"tombstoned":true');
  });

  it('tombstone preserved at equal lamport (tombstone local + live remote)', async () => {
    const local = new InMemoryKv();
    local.put('k1', tombBytes(5));
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: liveBytes(5) },
    ];
    const result = await runJoinSnapshot(remote, makeDeps(local));

    expect(result.liveLanded).toBe(0);
    expect(result.localWon).toBe(1);
    const local1 = local.get('k1')!;
    expect(new TextDecoder().decode(local1)).toContain('"tombstoned":true');
  });

  it('resurrects tombstone when remote live lamport > tombstone lamport', async () => {
    const local = new InMemoryKv();
    local.put('k1', tombBytes(5));
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: liveBytes(10, 'fresh') },
    ];
    const result = await runJoinSnapshot(remote, makeDeps(local));

    expect(result.liveLanded).toBe(1);
    expect(result.localWon).toBe(0);
    const local1 = local.get('k1')!;
    expect(new TextDecoder().decode(local1)).toContain('"fresh"');
    expect(new TextDecoder().decode(local1)).not.toContain('tombstoned');
  });
});

describe('runJoinSnapshot — idempotence', () => {
  it('re-running on the same remote is a no-op after the first pass', async () => {
    const local = new InMemoryKv();
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: liveBytes(5, 'A') },
      { key: 'k2', encryptedValue: tombBytes(2) },
    ];

    const first = await runJoinSnapshot(remote, makeDeps(local));
    expect(first.liveLanded + first.tombstonesLanded).toBe(2);
    expect(first.localWon).toBe(0);

    const second = await runJoinSnapshot(remote, makeDeps(local));
    expect(second.liveLanded).toBe(0);
    expect(second.tombstonesLanded).toBe(0);
    expect(second.localWon).toBe(2);

    const third = await runJoinSnapshot(remote, makeDeps(local));
    expect(third.localWon).toBe(2);
  });
});

describe('runJoinSnapshot — bidirectional convergence', () => {
  it('two peers JOINing each other converge to the higher-Lamport state', async () => {
    const peerA = new InMemoryKv();
    const peerB = new InMemoryKv();
    peerA.put('k1', liveBytes(3, 'A-state'));
    peerB.put('k1', liveBytes(7, 'B-state'));

    // A pulls B's snapshot.
    const resAtoB = await runJoinSnapshot(peerB.snapshot(), makeDeps(peerA));
    expect(resAtoB.liveLanded).toBe(1);

    // B pulls A's (now-updated) snapshot.
    const resBtoA = await runJoinSnapshot(peerA.snapshot(), makeDeps(peerB));
    expect(resBtoA.localWon).toBe(1); // B already has the higher lamport.

    // Both peers now agree on the higher-Lamport state.
    expect(new TextDecoder().decode(peerA.get('k1')!)).toContain('B-state');
    expect(new TextDecoder().decode(peerB.get('k1')!)).toContain('B-state');
  });

  it('non-overlapping union: A and B both have unique entries → both see both', async () => {
    const peerA = new InMemoryKv();
    const peerB = new InMemoryKv();
    peerA.put('k1', liveBytes(5, 'A-only'));
    peerB.put('k2', liveBytes(5, 'B-only'));

    // A pulls B → A picks up k2.
    await runJoinSnapshot(peerB.snapshot(), makeDeps(peerA));
    // B pulls A → B picks up k1.
    await runJoinSnapshot(peerA.snapshot(), makeDeps(peerB));

    expect(peerA.has('k1')).toBe(true);
    expect(peerA.has('k2')).toBe(true);
    expect(peerB.has('k1')).toBe(true);
    expect(peerB.has('k2')).toBe(true);
  });
});

describe('runJoinSnapshot — malformed handling', () => {
  it('counts unparseable remote entries as remoteRejectedMalformed', async () => {
    const local = new InMemoryKv();
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: new TextEncoder().encode('not-json{') },
      { key: 'k2', encryptedValue: liveBytes(5) },
    ];
    const result = await runJoinSnapshot(remote, makeDeps(local));
    expect(result.entriesEvaluated).toBe(2);
    expect(result.remoteRejectedMalformed).toBe(1);
    expect(result.liveLanded).toBe(1);
  });

  it('counts out-of-bounds Lamport as remoteRejectedMalformed', async () => {
    const local = new InMemoryKv();
    const remote: SnapshotEntry[] = [
      {
        key: 'k1',
        encryptedValue: new TextEncoder().encode(
          JSON.stringify({ lamport: MAX_SAFE_LAMPORT + 1, payload: 'x' }),
        ),
      },
    ];
    const result = await runJoinSnapshot(remote, makeDeps(local));
    expect(result.remoteRejectedMalformed).toBe(1);
    expect(result.liveLanded).toBe(0);
    expect(local.has('k1')).toBe(false);
  });

  it('treats local classify-throw as absent (remote lands)', async () => {
    const local = new InMemoryKv();
    local.put('k1', new TextEncoder().encode('local-bytes'));
    const deps: JoinDeps = {
      classifyLocal: async () => {
        throw new Error('local decode broke');
      },
      classifyRemote: async (entry) => classifyBytes(entry.encryptedValue),
      writeRemote: async (key, bytes) => local.put(key, bytes),
    };
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: liveBytes(5, 'fresh') },
    ];
    const result = await runJoinSnapshot(remote, deps);
    expect(result.liveLanded).toBe(1);
    expect(new TextDecoder().decode(local.get('k1')!)).toContain('fresh');
  });

  it('counts writeRemote throw as remoteRejectedMalformed; local untouched', async () => {
    const local = new InMemoryKv();
    let attempted = 0;
    const deps: JoinDeps = {
      classifyLocal: async () => ({ kind: 'absent' }),
      classifyRemote: async (entry) => classifyBytes(entry.encryptedValue),
      writeRemote: async () => {
        attempted += 1;
        throw new Error('disk full');
      },
    };
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: liveBytes(5) },
    ];
    const result = await runJoinSnapshot(remote, deps);
    expect(result.remoteRejectedMalformed).toBe(1);
    expect(result.liveLanded).toBe(0);
    expect(attempted).toBe(1);
    expect(local.has('k1')).toBe(false);
  });

  it('classifyRemote throw → remoteRejectedMalformed; loop continues', async () => {
    const local = new InMemoryKv();
    let calls = 0;
    const deps: JoinDeps = {
      classifyLocal: async () => ({ kind: 'absent' }),
      classifyRemote: async (entry) => {
        calls += 1;
        if (entry.key === 'k1') throw new Error('bad blob');
        return classifyBytes(entry.encryptedValue);
      },
      writeRemote: async (key, bytes) => local.put(key, bytes),
    };
    const remote: SnapshotEntry[] = [
      { key: 'k1', encryptedValue: liveBytes(5) },
      { key: 'k2', encryptedValue: liveBytes(7) },
    ];
    const result = await runJoinSnapshot(remote, deps);
    expect(calls).toBe(2);
    expect(result.entriesEvaluated).toBe(2);
    expect(result.remoteRejectedMalformed).toBe(1);
    expect(result.liveLanded).toBe(1);
    expect(local.has('k1')).toBe(false);
    expect(local.has('k2')).toBe(true);
  });
});

describe('runJoinSnapshot — empty remote', () => {
  it('returns zero counters on empty remote', async () => {
    const local = new InMemoryKv();
    local.put('k1', liveBytes(5));
    const result = await runJoinSnapshot([], makeDeps(local));
    expect(result.entriesEvaluated).toBe(0);
    expect(result.liveLanded).toBe(0);
    expect(result.tombstonesLanded).toBe(0);
    expect(result.localWon).toBe(0);
    expect(result.remoteRejectedMalformed).toBe(0);
    // Local untouched.
    expect(local.has('k1')).toBe(true);
  });
});
