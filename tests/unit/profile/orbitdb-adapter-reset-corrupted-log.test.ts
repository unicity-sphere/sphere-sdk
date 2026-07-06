/**
 * Tests for `OrbitDbAdapter.resetCorruptedLog` and `extractLostHeadCid`.
 *
 * The reset path is the recovery hook for the "Failed to load block for
 * <CID>" failure mode (browser MemoryBlockstore + persisted level state
 * → dangling OpLog head → every write fails forever). Item #157.
 *
 * @see profile/orbitdb-adapter.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OrbitDbAdapter,
  ProfileError,
  extractLostHeadCid,
} from '../../../extensions/uxf/profile/orbitdb-adapter';

// ---------------------------------------------------------------------------
// resetCorruptedLog
// ---------------------------------------------------------------------------

describe('OrbitDbAdapter.resetCorruptedLog', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Build an adapter wired up as if `connect()` had completed: handles
   * are present, `connected=true`, and `currentConfig` is captured.
   */
  function newConnectedAdapter(opts: { withDrop?: boolean; dropThrows?: boolean } = {}): {
    adapter: OrbitDbAdapter;
    handles: {
      db: {
        close: ReturnType<typeof vi.fn>;
        drop?: ReturnType<typeof vi.fn>;
      };
      orbitdb: { stop: ReturnType<typeof vi.fn> };
      helia: { stop: ReturnType<typeof vi.fn> };
    };
    connectSpy: ReturnType<typeof vi.fn>;
  } {
    const adapter = new OrbitDbAdapter();
    const handles = {
      db: {
        close: vi.fn().mockResolvedValue(undefined as never),
        ...(opts.withDrop
          ? {
              drop: vi.fn(
                opts.dropThrows
                  ? () => Promise.reject(new Error('drop boom'))
                  : () => Promise.resolve(undefined),
              ),
            }
          : {}),
      },
      orbitdb: { stop: vi.fn().mockResolvedValue(undefined as never) },
      helia: { stop: vi.fn().mockResolvedValue(undefined as never) },
    };
    const internal = adapter as unknown as {
      connected: boolean;
      db: unknown;
      orbitdb: unknown;
      helia: unknown;
      currentConfig: unknown;
    };
    internal.connected = true;
    internal.db = handles.db;
    internal.orbitdb = handles.orbitdb;
    internal.helia = handles.helia;
    internal.currentConfig = { privateKey: 'aa'.repeat(32) };
    // Stub `connect` so the test exercises only the reset code path
    // without actually invoking the Helia/OrbitDB dynamic imports.
    const connectSpy = vi.fn(async () => {
      // Pretend reconnect rebuilt the same handle shapes.
      internal.connected = true;
      internal.db = handles.db;
      internal.orbitdb = handles.orbitdb;
      internal.helia = handles.helia;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (adapter as any).connect = connectSpy;
    return { adapter, handles, connectSpy };
  }

  it('calls db.drop() when present, then closes, then reconnects', async () => {
    const { adapter, handles, connectSpy } = newConnectedAdapter({ withDrop: true });

    const result = await adapter.resetCorruptedLog({
      lostHeadCid: 'bafyabcdef',
      context: 'test',
    });

    expect(handles.db.drop).toHaveBeenCalledTimes(1);
    expect(handles.db.close).toHaveBeenCalledTimes(1);
    expect(handles.orbitdb.stop).toHaveBeenCalledTimes(1);
    expect(handles.helia.stop).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(result.recovered).toBe(true);
    expect(result.lostHeadCid).toBe('bafyabcdef');
    expect(result.recoveredAt).toBeTypeOf('number');
    expect(Math.abs(result.recoveredAt - Date.now())).toBeLessThan(2000);
  });

  it('tolerates a missing db.drop() and still close+reconnects', async () => {
    const { adapter, handles, connectSpy } = newConnectedAdapter({ withDrop: false });

    const result = await adapter.resetCorruptedLog({
      lostHeadCid: 'bafyzzz',
      context: 'unit',
    });

    // No drop method to call; reset still proceeds.
    expect((handles.db as { drop?: unknown }).drop).toBeUndefined();
    expect(handles.db.close).toHaveBeenCalledTimes(1);
    expect(handles.orbitdb.stop).toHaveBeenCalledTimes(1);
    expect(handles.helia.stop).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(result.recovered).toBe(true);
    expect(result.lostHeadCid).toBe('bafyzzz');
  });

  it('tolerates db.drop() throwing — close + reconnect still happen', async () => {
    const { adapter, handles, connectSpy } = newConnectedAdapter({
      withDrop: true,
      dropThrows: true,
    });

    const result = await adapter.resetCorruptedLog({
      lostHeadCid: 'bafyqqq',
      context: 'unit',
    });

    expect(handles.db.drop).toHaveBeenCalledTimes(1);
    // Even though drop threw, close + reconnect still ran.
    expect(handles.db.close).toHaveBeenCalledTimes(1);
    expect(handles.orbitdb.stop).toHaveBeenCalledTimes(1);
    expect(handles.helia.stop).toHaveBeenCalledTimes(1);
    expect(connectSpy).toHaveBeenCalledTimes(1);
    expect(result.recovered).toBe(true);
  });

  it('returns { recovered, lostHeadCid?, recoveredAt: now } with current timestamp', async () => {
    const { adapter } = newConnectedAdapter({ withDrop: true });
    const t0 = Date.now();
    const result = await adapter.resetCorruptedLog({
      lostHeadCid: 'bafytest',
      context: 'timestamp-check',
    });
    const t1 = Date.now();
    expect(result.recoveredAt).toBeGreaterThanOrEqual(t0);
    expect(result.recoveredAt).toBeLessThanOrEqual(t1 + 5);
    expect(result.lostHeadCid).toBe('bafytest');
  });

  it('returns undefined lostHeadCid when caller did not supply one', async () => {
    const { adapter } = newConnectedAdapter({ withDrop: true });
    const result = await adapter.resetCorruptedLog({ context: 'no-cid' });
    expect(result.lostHeadCid).toBeUndefined();
    expect(result.recovered).toBe(true);
  });

  it('throws ProfileError when no currentConfig is captured', async () => {
    const adapter = new OrbitDbAdapter();
    // Adapter has never connected — currentConfig is null.

    let thrown: unknown = null;
    try {
      await adapter.resetCorruptedLog({ context: 'no-config' });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ProfileError);
    expect((thrown as ProfileError).code).toBe('ORBITDB_CONNECTION_FAILED');
    expect((thrown as ProfileError).message).toContain('no captured OrbitDbConfig');
  });
});

// ---------------------------------------------------------------------------
// extractLostHeadCid
// ---------------------------------------------------------------------------

describe('extractLostHeadCid', () => {
  it('matches the standard "Failed to load block for <CID>" pattern', () => {
    const err = new Error(
      'Failed to load block for bafyreiedrpijj5amqkx4o2aabcdefghijklmnopqrstuvwxyz',
    );
    expect(extractLostHeadCid(err)).toBe(
      'bafyreiedrpijj5amqkx4o2aabcdefghijklmnopqrstuvwxyz',
    );
  });

  it('matches the actual production CID shape', () => {
    const err = new Error(
      'Failed to load block for bafyreid2y67vjqubk66rb6fzie2hfyz4t4nitg5corsxfhk2x6jljdzp5a',
    );
    expect(extractLostHeadCid(err)).toBe(
      'bafyreid2y67vjqubk66rb6fzie2hfyz4t4nitg5corsxfhk2x6jljdzp5a',
    );
  });

  it('is case-insensitive on the verb prefix', () => {
    const err = new Error('failed to LOAD BLOCK FOR bafyzzz123');
    expect(extractLostHeadCid(err)).toBe('bafyzzz123');
  });

  it('returns null on unrelated errors', () => {
    expect(extractLostHeadCid(new Error('ECONNRESET'))).toBeNull();
    expect(extractLostHeadCid(new Error('timeout'))).toBeNull();
    expect(extractLostHeadCid(new Error(''))).toBeNull();
    expect(extractLostHeadCid(null)).toBeNull();
    expect(extractLostHeadCid(undefined)).toBeNull();
    expect(extractLostHeadCid('plain string with no CID')).toBeNull();
  });

  it('does NOT match non-CID strings (e.g., "unknown")', () => {
    expect(extractLostHeadCid(new Error('Failed to load block for unknown'))).toBeNull();
    expect(extractLostHeadCid(new Error('Failed to load block for QmHash'))).toBeNull();
    expect(extractLostHeadCid(new Error('Failed to load block for'))).toBeNull();
  });

  it('walks .cause chain up to 4 levels deep', () => {
    // 4-level cause chain: ProfileError → wrapping1 → wrapping2 → Helia.
    const root = new Error('Failed to load block for bafydeep4');
    const w1 = new Error('OrbitDB write failed') as Error & { cause?: unknown };
    w1.cause = root;
    const w2 = new Error('Profile flush failed') as Error & { cause?: unknown };
    w2.cause = w1;
    const profile = new Error('Bundle index error') as Error & { cause?: unknown };
    profile.cause = w2;
    expect(extractLostHeadCid(profile)).toBe('bafydeep4');
  });

  it('stops at 4-level cause depth (does not recurse forever)', () => {
    // 5-level chain — deepest match should be unreachable.
    const deepest = new Error('Failed to load block for bafyunreachable');
    const layers: Array<Error & { cause?: unknown }> = [];
    for (let i = 0; i < 5; i++) {
      const e = new Error(`layer ${i}`) as Error & { cause?: unknown };
      layers.push(e);
    }
    layers[4].cause = deepest;
    for (let i = 0; i < 4; i++) {
      layers[i].cause = layers[i + 1];
    }
    // Only walks layers 0..3 inclusive (4 levels); layers[4]'s .cause
    // (the deepest) is past the budget.
    expect(extractLostHeadCid(layers[0])).toBeNull();
  });

  it('matches inside a ProfileError-wrapped chain (the production shape)', () => {
    const helia = new Error(
      'Failed to load block for bafyreiedrpijj5amqkx4o2',
    );
    const wrapped = new ProfileError(
      'ORBITDB_WRITE_FAILED',
      'Failed to write structured entry at "tokens.bundle.foo": something',
      helia,
    );
    expect(extractLostHeadCid(wrapped)).toBe('bafyreiedrpijj5amqkx4o2');
  });

  it('does not match arbitrary text matching "bafy" prefix elsewhere', () => {
    // Pattern is anchored to the specific verb prefix.
    const err = new Error('bafyabc shows up in some other message');
    expect(extractLostHeadCid(err)).toBeNull();
  });

  it('handles cause = self gracefully (no infinite loop)', () => {
    const e = new Error('Some error') as Error & { cause?: unknown };
    e.cause = e;
    expect(extractLostHeadCid(e)).toBeNull();
  });
});
