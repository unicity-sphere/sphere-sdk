/**
 * Tests for profile/orbitdb-adapter.ts
 *
 * Since @orbitdb/core and helia are not installed, we test the OrbitDbAdapter
 * using mocks for all dynamic imports. We also test the ProfileDatabase
 * interface contract using an in-memory mock.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProfileDatabase, OrbitDbConfig } from '../../../profile/types';
import { OrbitDbAdapter } from '../../../profile/orbitdb-adapter';

// ---------------------------------------------------------------------------
// Mock ProfileDatabase (in-memory Map-based implementation)
// ---------------------------------------------------------------------------

interface MockProfileDatabase extends ProfileDatabase {
  _triggerReplication(): void;
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDatabase {
  const store = new Map<string, Uint8Array>();
  const listeners: Array<() => void> = [];
  let connected = false;

  return {
    _store: store,
    async connect(_config: OrbitDbConfig) {
      connected = true;
    },
    async put(key: string, value: Uint8Array) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      store.delete(key);
    },
    async all(prefix?: string) {
      const result = new Map<string, Uint8Array>();
      for (const [k, v] of store) {
        if (!prefix || k.startsWith(prefix)) {
          result.set(k, v);
        }
      }
      return result;
    },
    async close() {
      connected = false;
      listeners.length = 0;
    },
    onReplication(cb: () => void) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    isConnected() {
      return connected;
    },
    _triggerReplication() {
      listeners.forEach((cb) => cb());
    },
  } as MockProfileDatabase;
}

// ---------------------------------------------------------------------------
// Tests for the mock ProfileDatabase (exercising the interface contract)
// ---------------------------------------------------------------------------

describe('ProfileDatabase mock (interface contract)', () => {
  let db: MockProfileDatabase;

  beforeEach(() => {
    db = createMockDb();
  });

  // -- put/get/del round-trip --

  it('put then get returns the stored value', async () => {
    const value = new Uint8Array([1, 2, 3, 4]);
    await db.put('key1', value);
    const result = await db.get('key1');
    expect(result).toEqual(value);
  });

  it('get on missing key returns null', async () => {
    const result = await db.get('nonexistent');
    expect(result).toBeNull();
  });

  it('del removes the key', async () => {
    const value = new Uint8Array([10, 20]);
    await db.put('k', value);
    await db.del('k');
    const result = await db.get('k');
    expect(result).toBeNull();
  });

  it('put overwrites existing value', async () => {
    const v1 = new Uint8Array([1]);
    const v2 = new Uint8Array([2]);
    await db.put('k', v1);
    await db.put('k', v2);
    const result = await db.get('k');
    expect(result).toEqual(v2);
  });

  // -- all() with prefix filtering --

  it('all() returns all entries', async () => {
    await db.put('a.1', new Uint8Array([1]));
    await db.put('a.2', new Uint8Array([2]));
    await db.put('b.1', new Uint8Array([3]));

    const result = await db.all();
    expect(result.size).toBe(3);
    expect(result.has('a.1')).toBe(true);
    expect(result.has('a.2')).toBe(true);
    expect(result.has('b.1')).toBe(true);
  });

  it('all(prefix) filters by prefix', async () => {
    await db.put('a.1', new Uint8Array([1]));
    await db.put('a.2', new Uint8Array([2]));
    await db.put('b.1', new Uint8Array([3]));

    const result = await db.all('a.');
    expect(result.size).toBe(2);
    expect(result.has('a.1')).toBe(true);
    expect(result.has('a.2')).toBe(true);
    expect(result.has('b.1')).toBe(false);
  });

  it('all() returns empty map when store is empty', async () => {
    const result = await db.all();
    expect(result.size).toBe(0);
  });

  it('all(prefix) returns empty map when no keys match prefix', async () => {
    await db.put('a.1', new Uint8Array([1]));
    const result = await db.all('z.');
    expect(result.size).toBe(0);
  });

  // -- onReplication / close --

  it('onReplication callback fires when triggered', () => {
    const callback = vi.fn();
    db.onReplication(callback);
    db._triggerReplication();
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('onReplication supports multiple listeners', () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    db.onReplication(cb1);
    db.onReplication(cb2);
    db._triggerReplication();
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it('onReplication unsubscribe removes the listener', () => {
    const callback = vi.fn();
    const unsub = db.onReplication(callback);
    unsub();
    db._triggerReplication();
    expect(callback).not.toHaveBeenCalled();
  });

  it('close() disconnects and clears listeners', async () => {
    const callback = vi.fn();
    db.onReplication(callback);
    expect(db.isConnected()).toBe(false); // not yet connected

    await db.connect({ privateKey: 'aabb' });
    expect(db.isConnected()).toBe(true);

    await db.close();
    expect(db.isConnected()).toBe(false);

    // Listeners cleared -- triggering should not call callback
    db._triggerReplication();
    expect(callback).not.toHaveBeenCalled();
  });

  it('connect sets isConnected to true', async () => {
    expect(db.isConnected()).toBe(false);
    await db.connect({ privateKey: 'aabb' });
    expect(db.isConnected()).toBe(true);
  });

  it('isConnected returns false before connect', () => {
    expect(db.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// close() teardown budget (#137)
//
// libp2p / gossipsub teardown can hang indefinitely under load (and during
// e2e cleanup the hang propagated up through Sphere.destroy()). Each step
// of OrbitDbAdapter.close() now has a 10s budget — on timeout we drop the
// reference and continue rather than awaiting forever.
// ---------------------------------------------------------------------------

describe('OrbitDbAdapter.close() teardown budget', () => {
  const STEP_BUDGET_MS = 10_000;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function newConnectedAdapter(): {
    adapter: OrbitDbAdapter;
    handles: { db: { close: ReturnType<typeof vi.fn> }; orbitdb: { stop: ReturnType<typeof vi.fn> }; helia: { stop: ReturnType<typeof vi.fn> } };
  } {
    const adapter = new OrbitDbAdapter();
    const handles = {
      db: { close: vi.fn(() => new Promise<void>(() => { /* never resolves */ })) },
      orbitdb: { stop: vi.fn().mockResolvedValue(undefined) },
      helia: { stop: vi.fn().mockResolvedValue(undefined) },
    };
    const internal = adapter as unknown as {
      connected: boolean;
      db: unknown;
      orbitdb: unknown;
      helia: unknown;
    };
    internal.connected = true;
    internal.db = handles.db;
    internal.orbitdb = handles.orbitdb;
    internal.helia = handles.helia;
    return { adapter, handles };
  }

  it('returns within budget when db.close() hangs', async () => {
    const { adapter, handles } = newConnectedAdapter();

    const closePromise = adapter.close();
    // Advance fake clock past the 10s budget so the race resolves.
    await vi.advanceTimersByTimeAsync(STEP_BUDGET_MS + 100);
    await closePromise;

    expect(handles.db.close).toHaveBeenCalled();
    // Subsequent steps still run after the timeout fires.
    expect(handles.orbitdb.stop).toHaveBeenCalled();
    expect(handles.helia.stop).toHaveBeenCalled();
    expect(adapter.isConnected()).toBe(false);
  });

  it('proceeds when orbitdb.stop() hangs', async () => {
    const { adapter, handles } = newConnectedAdapter();
    handles.db.close.mockResolvedValue(undefined as never);
    handles.orbitdb.stop.mockImplementation(() => new Promise<void>(() => { /* hang */ }));

    const closePromise = adapter.close();
    await vi.advanceTimersByTimeAsync(STEP_BUDGET_MS + 100);
    await closePromise;

    expect(handles.helia.stop).toHaveBeenCalled();
    expect(adapter.isConnected()).toBe(false);
  });

  it('proceeds when helia.stop() hangs', async () => {
    const { adapter, handles } = newConnectedAdapter();
    handles.db.close.mockResolvedValue(undefined as never);
    handles.orbitdb.stop.mockResolvedValue(undefined as never);
    handles.helia.stop.mockImplementation(() => new Promise<void>(() => { /* hang */ }));

    const closePromise = adapter.close();
    await vi.advanceTimersByTimeAsync(STEP_BUDGET_MS + 100);
    await closePromise;

    expect(adapter.isConnected()).toBe(false);
  });

  it('fast-path: all steps resolve immediately', async () => {
    const { adapter, handles } = newConnectedAdapter();
    handles.db.close.mockResolvedValue(undefined as never);

    await adapter.close();

    expect(handles.db.close).toHaveBeenCalled();
    expect(handles.orbitdb.stop).toHaveBeenCalled();
    expect(handles.helia.stop).toHaveBeenCalled();
    expect(adapter.isConnected()).toBe(false);
  });
});
