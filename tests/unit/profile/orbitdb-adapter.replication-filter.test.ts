/**
 * Regression tests for Issue #360 Findings #1 and #7 — profile sync
 * amplification root cause.
 *
 *   #1: `onReplication`'s `'update'` handler fired for BOTH local
 *       `addOperation` and remote `applyOperation` (OrbitDB upstream
 *       emits `'update'` in both code paths). Pre-fix, every local
 *       save triggered a full aggregator poll + bundle CAR re-fetch
 *       in `ProfileTokenStorageProvider.handleReplication`. The fix
 *       filters on the entry's `identity` field against
 *       `this.db.identity.hash` captured at connect time.
 *
 *   #7: `localAuthoredKeys` was an unbounded `Set<string>` that grew
 *       on every local PUT and was cleared only on a replication
 *       'update' (whether ours or peer's) or close(). The fix
 *       replaces it with a bounded LRU (max 1000) preserving the
 *       same `has`/`add`/`clear` API.
 *
 * Tests interact with the OrbitDbAdapter via internal-field injection
 * (the same pattern used by `orbitdb-adapter.test.ts`'s close-budget
 * tests) so we can drive the 'update' emitter without spinning up a
 * real Helia + OrbitDB stack.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OrbitDbAdapter } from '../../../profile/orbitdb-adapter';

// ---------------------------------------------------------------------------
// Test fixture — minimal stand-in for an open OrbitDB database. The adapter
// only consults `this.db.events.on('update', handler)`, `this.db.identity`,
// and a few other read-only fields, so a hand-rolled event emitter suffices.
// ---------------------------------------------------------------------------

interface FakeDb {
  identity: { hash: string };
  events: {
    on: (name: 'update', handler: (entry: unknown) => void) => void;
    off: (name: 'update', handler: (entry: unknown) => void) => void;
    emit: (name: 'update', entry: unknown) => void;
    _handlers: Set<(entry: unknown) => void>;
  };
}

function createFakeDb(identityHash: string): FakeDb {
  const handlers = new Set<(entry: unknown) => void>();
  return {
    identity: { hash: identityHash },
    events: {
      _handlers: handlers,
      on(_name: 'update', handler) {
        handlers.add(handler);
      },
      off(_name: 'update', handler) {
        handlers.delete(handler);
      },
      emit(_name: 'update', entry) {
        handlers.forEach((h) => h(entry));
      },
    },
  };
}

/**
 * Build an adapter pre-loaded with a connected fake DB at a known
 * identity hash. We bypass `connect()` because that path drags in
 * Helia + OrbitDB dynamic imports.
 */
function newAdapterWithFakeDb(identityHash: string): {
  adapter: OrbitDbAdapter;
  db: FakeDb;
} {
  const adapter = new OrbitDbAdapter();
  const db = createFakeDb(identityHash);
  const internal = adapter as unknown as {
    connected: boolean;
    db: FakeDb;
    ownIdentityId: string | null;
  };
  internal.connected = true;
  internal.db = db;
  internal.ownIdentityId = identityHash;
  return { adapter, db };
}

// ---------------------------------------------------------------------------
// Finding #1 — replication callback filtered by identity
// ---------------------------------------------------------------------------

describe('OrbitDbAdapter.onReplication — identity filter (Issue #360 #1)', () => {
  const OUR_ID = 'zdpuOurOwnIdentityHashAbc123';
  const PEER_ID = 'zdpuPeerIdentityHashXyz789';

  let adapter: OrbitDbAdapter;
  let db: FakeDb;

  beforeEach(() => {
    ({ adapter, db } = newAdapterWithFakeDb(OUR_ID));
  });

  it('does NOT fire callback when update entry was authored by us', () => {
    const callback = vi.fn();
    adapter.onReplication(callback);

    // Simulate the OrbitDB 'update' event for our own write
    // (addOperation path in @orbitdb/core/database.js).
    db.events.emit('update', {
      payload: { op: 'PUT', key: 'k1', value: new Uint8Array([1]) },
      identity: OUR_ID,
      clock: { time: 1 },
      hash: 'zdpuEntryHash1',
    });

    expect(callback).not.toHaveBeenCalled();
  });

  it('FIRES callback when update entry was authored by a peer', () => {
    const callback = vi.fn();
    adapter.onReplication(callback);

    // Simulate the OrbitDB 'update' event for a peer's write
    // (applyOperation path).
    db.events.emit('update', {
      payload: { op: 'PUT', key: 'k1', value: new Uint8Array([1]) },
      identity: PEER_ID,
      clock: { time: 1 },
      hash: 'zdpuEntryHash2',
    });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('falls back to firing when entry has no identity field (unknown shape)', () => {
    const callback = vi.fn();
    adapter.onReplication(callback);

    // Defensive: future OrbitDB versions or test stubs may emit
    // entries without identity. The conservative default fires the
    // callback so the upper layer's diff guard can decide.
    db.events.emit('update', { payload: { op: 'PUT' } });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('falls back to firing when ownIdentityId is null', () => {
    const callback = vi.fn();
    // Clear the captured identity hash to simulate a legacy / test-stub
    // adapter that never recorded one.
    (adapter as unknown as { ownIdentityId: string | null }).ownIdentityId = null;
    adapter.onReplication(callback);

    db.events.emit('update', {
      payload: {},
      identity: OUR_ID,
    });

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('local-write update does NOT clear localAuthoredKeys', () => {
    const callback = vi.fn();
    adapter.onReplication(callback);

    // Seed a locally-authored key (the markLocallyAuthored public surface).
    adapter.markLocallyAuthored('tokens.bundle.bafyfoo');
    const internal = adapter as unknown as {
      localAuthoredKeys: { has(k: string): boolean };
    };
    expect(internal.localAuthoredKeys.has('tokens.bundle.bafyfoo')).toBe(true);

    db.events.emit('update', { identity: OUR_ID, payload: {} });

    // Our own 'update' must not invalidate the key — pre-#360 it did.
    expect(internal.localAuthoredKeys.has('tokens.bundle.bafyfoo')).toBe(true);
    expect(callback).not.toHaveBeenCalled();
  });

  it('peer-write update DOES clear localAuthoredKeys (conservative invalidation)', () => {
    const callback = vi.fn();
    adapter.onReplication(callback);

    adapter.markLocallyAuthored('tokens.bundle.bafyfoo');
    const internal = adapter as unknown as {
      localAuthoredKeys: { has(k: string): boolean };
    };

    db.events.emit('update', { identity: PEER_ID, payload: {} });

    // A peer replication event still invalidates the trust set so a
    // subsequent getEntry doesn't return a tag the peer may have
    // overwritten via LWW.
    expect(internal.localAuthoredKeys.has('tokens.bundle.bafyfoo')).toBe(false);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Finding #7 — bounded localAuthoredKeys LRU
// ---------------------------------------------------------------------------

describe('OrbitDbAdapter.localAuthoredKeys — bounded LRU (Issue #360 #7)', () => {
  it('evicts the oldest key when the set exceeds max capacity', () => {
    const adapter = new OrbitDbAdapter();
    // Force-connect the adapter so markLocallyAuthored is reachable.
    const internal = adapter as unknown as {
      connected: boolean;
      db: unknown;
      localAuthoredKeys: { has(k: string): boolean; size: number };
    };
    internal.connected = true;
    internal.db = {};

    // The implementation caps at 1000 keys (constant
    // LOCAL_AUTHORED_KEYS_MAX). Add 1001 distinct keys and assert the
    // oldest fell out.
    const MAX = 1000;
    const firstKey = 'k-0';
    for (let i = 0; i < MAX + 1; i++) {
      adapter.markLocallyAuthored(`k-${i}`);
    }

    expect(internal.localAuthoredKeys.has(firstKey)).toBe(false);
    // Recent additions still resident.
    expect(internal.localAuthoredKeys.has(`k-${MAX}`)).toBe(true);
    // Set size never exceeds the cap.
    expect(internal.localAuthoredKeys.size).toBeLessThanOrEqual(MAX);
  });

  it('re-adding an existing key refreshes its position (LRU recency)', () => {
    const adapter = new OrbitDbAdapter();
    const internal = adapter as unknown as {
      connected: boolean;
      db: unknown;
      localAuthoredKeys: { has(k: string): boolean; size: number };
    };
    internal.connected = true;
    internal.db = {};

    const MAX = 1000;
    // Fill to capacity.
    for (let i = 0; i < MAX; i++) {
      adapter.markLocallyAuthored(`k-${i}`);
    }
    // Touch the oldest key — should move to most-recent.
    adapter.markLocallyAuthored('k-0');
    // Trigger one more eviction.
    adapter.markLocallyAuthored('k-new');

    // k-0 survived because it was refreshed; k-1 (the new oldest) fell out.
    expect(internal.localAuthoredKeys.has('k-0')).toBe(true);
    expect(internal.localAuthoredKeys.has('k-1')).toBe(false);
    expect(internal.localAuthoredKeys.has('k-new')).toBe(true);
  });

  it('clear() empties the set', () => {
    const adapter = new OrbitDbAdapter();
    const internal = adapter as unknown as {
      connected: boolean;
      db: unknown;
      localAuthoredKeys: { has(k: string): boolean; size: number; clear(): void };
    };
    internal.connected = true;
    internal.db = {};

    adapter.markLocallyAuthored('a');
    adapter.markLocallyAuthored('b');
    expect(internal.localAuthoredKeys.size).toBe(2);

    internal.localAuthoredKeys.clear();
    expect(internal.localAuthoredKeys.has('a')).toBe(false);
    expect(internal.localAuthoredKeys.has('b')).toBe(false);
    expect(internal.localAuthoredKeys.size).toBe(0);
  });
});
