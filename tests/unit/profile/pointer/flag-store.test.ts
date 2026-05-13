/**
 * FlagStore (T-B1) — per-wallet scoping + durability guard.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FlagStore, DURABLE_STORAGE, isDurableProvider } from '../../../../profile/aggregator-pointer/index.js';
import { AggregatorPointerErrorCode } from '../../../../profile/aggregator-pointer/index.js';

// ── In-memory test storage providers ──────────────────────────────────────

function makeStore(durable: boolean) {
  const kv = new Map<string, string>();
  const base = {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => { kv.set(k, v); },
    remove: async (k: string) => { kv.delete(k); },
    has: async (k: string) => kv.has(k),
    keys: async (prefix?: string) => [...kv.keys()].filter(k => !prefix || k.startsWith(prefix)),
    clear: async (prefix?: string) => { for (const k of [...kv.keys()]) if (!prefix || k.startsWith(prefix)) kv.delete(k); },
    setIdentity: () => {},
    saveTrackedAddresses: async () => {},
    loadTrackedAddresses: async () => [],
    initialize: async () => {},
    shutdown: async () => {},
    name: 'test-storage',
  };
  if (durable) {
    (base as Record<symbol, unknown>)[DURABLE_STORAGE] = true;
  }
  return base as ReturnType<typeof makeStore>;
}

const VALID_PUBKEY = '0'.repeat(66);

describe('FlagStore (T-B1)', () => {
  it('isDurableProvider returns true for durable storage', () => {
    expect(isDurableProvider(makeStore(true) as never)).toBe(true);
  });

  it('isDurableProvider returns false for non-durable storage', () => {
    expect(isDurableProvider(makeStore(false) as never)).toBe(false);
  });

  it('FlagStore.create throws UNSUPPORTED_RUNTIME for non-durable backend', () => {
    const sp = makeStore(false);
    expect(() => FlagStore.create(sp as never, VALID_PUBKEY)).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.UNSUPPORTED_RUNTIME }),
    );
  });

  it('FlagStore.create succeeds for durable backend', () => {
    const sp = makeStore(true);
    expect(() => FlagStore.create(sp as never, VALID_PUBKEY)).not.toThrow();
  });

  it('FlagStore.create rejects malformed pubkey hex', () => {
    const sp = makeStore(true);
    expect(() => FlagStore.create(sp as never, 'not-hex')).toThrow(RangeError);
    expect(() => FlagStore.create(sp as never, '00'.repeat(32))).toThrow(RangeError); // 32 bytes not 33
  });

  describe('per-wallet scoping', () => {
    const pubkeyA = 'aa'.repeat(33);
    const pubkeyB = 'bb'.repeat(33);
    let sp: ReturnType<typeof makeStore>;

    beforeEach(() => { sp = makeStore(true); });

    it('keys are isolated between different wallets', async () => {
      const fsA = FlagStore.create(sp as never, pubkeyA);
      const fsB = FlagStore.create(sp as never, pubkeyB);

      await fsA.set('foo', 'valueA');
      await fsB.set('foo', 'valueB');

      expect(await fsA.get('foo')).toBe('valueA');
      expect(await fsB.get('foo')).toBe('valueB');
    });

    it('scopedKey includes prefix + local key', () => {
      const fs = FlagStore.create(sp as never, pubkeyA);
      const scoped = fs.scopedKey('pending_version');
      expect(scoped).toBe(`profile.pointer.${pubkeyA}.pending_version`);
    });

    it('get returns null for missing key', async () => {
      const fs = FlagStore.create(sp as never, pubkeyA);
      expect(await fs.get('nonexistent')).toBeNull();
    });

    it('has returns false for missing key', async () => {
      const fs = FlagStore.create(sp as never, pubkeyA);
      expect(await fs.has('nonexistent')).toBe(false);
    });

    it('remove deletes the key', async () => {
      const fs = FlagStore.create(sp as never, pubkeyA);
      await fs.set('x', 'y');
      await fs.remove('x');
      expect(await fs.get('x')).toBeNull();
    });
  });
});
