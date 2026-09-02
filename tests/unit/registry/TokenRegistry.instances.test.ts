/**
 * Owned registries: TokenRegistry.create() + dispose().
 *
 * The defect these pin, observed empirically: with a testnet2 Sphere live and holding a
 * coin, initialising a second Sphere on mainnet flipped the FIRST instance's own asset
 * from {symbol:'TCOIN', decimals:8} to {symbol:'AAAAAA', decimals:0} — a silent 10^8
 * scale error on a live balance. The mechanism was the process-global: configure()
 * reaches into whatever instance exists and repoints it, so every Sphere shared one.
 *
 * An owned registry must be immune to that, and must stop completely when disposed —
 * nothing here calls unref(), so a surviving interval keeps Node's event loop alive.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TokenRegistry } from '../../../registry';
import type { TokenDefinition } from '../../../registry';
import type { StorageProvider } from '../../../storage';

const URL_A = 'https://example.com/net-a.json';
const URL_B = 'https://example.com/net-b.json';

const COIN_A = 'aa'.repeat(32);
const COIN_B = 'bb'.repeat(32);

const defsA: TokenDefinition[] = [
  { network: 'unicity:net-a', assetKind: 'fungible', name: 'acoin', symbol: 'ACOIN', decimals: 8, description: 'A', id: COIN_A },
];
const defsB: TokenDefinition[] = [
  { network: 'unicity:net-b', assetKind: 'fungible', name: 'bcoin', symbol: 'BCOIN', decimals: 6, description: 'B', id: COIN_B },
];

function makeStorage(): { storage: StorageProvider; store: Map<string, string> } {
  const store = new Map<string, string>();
  const storage = {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => { store.set(k, v); },
    remove: async (k: string) => { store.delete(k); },
    has: async (k: string) => store.has(k),
    clear: async () => { store.clear(); },
    setIdentity: () => {},
  } as unknown as StorageProvider;
  return { storage, store };
}

/** Serve each URL its own definitions, and count requests per URL. */
function stubFetch(): { calls: string[]; restore: () => void } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = ((input: unknown) => {
    const url = String(input);
    calls.push(url);
    const body = url === URL_A ? defsA : url === URL_B ? defsB : [];
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** The private timer handle IS the leak, so assert on it directly. */
function hasLiveInterval(r: TokenRegistry): boolean {
  return (r as unknown as { refreshTimer: unknown }).refreshTimer !== null;
}

afterEach(() => {
  TokenRegistry.destroy();
  vi.useRealTimers();
});

describe('TokenRegistry.create — an owned registry is independent of the global', () => {
  it('resolves its own network while the global resolves another', async () => {
    const { storage } = makeStorage();
    const f = stubFetch();
    try {
      TokenRegistry.configure({ remoteUrl: URL_A, storage, autoRefresh: true });
      await TokenRegistry.waitForReady();

      const owned = TokenRegistry.create({ remoteUrl: URL_B, storage, autoRefresh: true });
      await owned.waitForReady();

      // Each answers for its OWN network, at the same moment.
      expect(owned.getSymbol(COIN_B)).toBe('BCOIN');
      expect(owned.getDecimals(COIN_B)).toBe(6);
      expect(TokenRegistry.getInstance().getSymbol(COIN_A)).toBe('ACOIN');
      expect(TokenRegistry.getInstance().getDecimals(COIN_A)).toBe(8);

      // ...and neither can see the other's coin.
      expect(owned.isKnown(COIN_A)).toBe(false);
      expect(TokenRegistry.getInstance().isKnown(COIN_B)).toBe(false);
    } finally {
      f.restore();
    }
  });

  it('survives the global being repointed — the exact reported defect', async () => {
    const { storage } = makeStorage();
    const f = stubFetch();
    try {
      const owned = TokenRegistry.create({ remoteUrl: URL_A, storage, autoRefresh: true });
      await owned.waitForReady();
      expect(owned.getDecimals(COIN_A)).toBe(8);

      // A second Sphere initialises on another network: it configures the global.
      TokenRegistry.configure({ remoteUrl: URL_B, storage, autoRefresh: true });
      await TokenRegistry.waitForReady();

      // The first wallet's metadata is untouched. Before this change it became
      // {symbol:'AAAAAA', decimals:0} — the miss fallbacks.
      expect(owned.getSymbol(COIN_A)).toBe('ACOIN');
      expect(owned.getDecimals(COIN_A)).toBe(8);
      expect(owned.isKnown(COIN_A)).toBe(true);
    } finally {
      f.restore();
    }
  });

  it('two owned registries on different networks do not disturb each other', async () => {
    const { storage } = makeStorage();
    const f = stubFetch();
    try {
      const a = TokenRegistry.create({ remoteUrl: URL_A, storage, autoRefresh: true });
      const b = TokenRegistry.create({ remoteUrl: URL_B, storage, autoRefresh: true });
      await Promise.all([a.waitForReady(), b.waitForReady()]);

      expect(a.getDecimals(COIN_A)).toBe(8);
      expect(b.getDecimals(COIN_B)).toBe(6);
      expect(a.isKnown(COIN_B)).toBe(false);
      expect(b.isKnown(COIN_A)).toBe(false);
    } finally {
      f.restore();
    }
  });
});

describe('TokenRegistry#dispose', () => {
  it('stops the refresh timer, so a discarded owner leaves no work behind', async () => {
    vi.useFakeTimers();
    const { storage } = makeStorage();
    const f = stubFetch();
    try {
      const owned = TokenRegistry.create({
        remoteUrl: URL_A,
        storage,
        autoRefresh: true,
        refreshIntervalMs: 1000,
      });
      await vi.advanceTimersByTimeAsync(0);
      const before = f.calls.length;
      expect(before).toBeGreaterThan(0);
      const timersBefore = vi.getTimerCount();
      expect(timersBefore).toBeGreaterThan(0);

      owned.dispose();
      expect(owned.isDisposed).toBe(true);

      // The interval must be CLEARED, not merely made inert by the disposed flag: an
      // un-cleared interval is the leak — it keeps Node's event loop alive on its own,
      // whether or not its callback still fetches.
      expect(vi.getTimerCount()).toBeLessThan(timersBefore);

      // ...and well past several intervals, no further fetch either.
      await vi.advanceTimersByTimeAsync(5000);
      expect(f.calls.length).toBe(before);
    } finally {
      f.restore();
    }
  });

  it('a response landing AFTER dispose is neither applied nor cached', async () => {
    const { storage, store } = makeStorage();
    let release!: (r: Response) => void;
    let requested = false;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const original = globalThis.fetch;
    globalThis.fetch = (() => { requested = true; return pending; }) as typeof globalThis.fetch;
    try {
      const owned = TokenRegistry.create({ remoteUrl: URL_A, storage, autoRefresh: true });
      for (let i = 0; i < 200 && !requested; i++) await new Promise((r) => setTimeout(r, 1));
      expect(requested).toBe(true); // the test is vacuous if the fetch never started

      owned.dispose();
      release(new Response(JSON.stringify(defsA), { status: 200 }));
      await new Promise((r) => setTimeout(r, 50));

      expect(owned.isKnown(COIN_A)).toBe(false);
      for (const [, v] of store) expect(v).not.toContain(COIN_A);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('starts no new work after dispose', async () => {
    const { storage } = makeStorage();
    const f = stubFetch();
    try {
      const owned = TokenRegistry.create({ remoteUrl: URL_A, storage, autoRefresh: true });
      await owned.waitForReady();
      owned.dispose();
      const after = f.calls.length;

      expect(await owned.refreshFromRemote()).toBe(false);
      expect(f.calls.length).toBe(after);
    } finally {
      f.restore();
    }
  });
  it('dispose DURING the initial load leaves no interval armed', async () => {
    // The entry guard in performInitialLoad has already passed by the time the fetch
    // resolves, and the continuation arms the interval. The callback would no-op via the
    // disposed flag, but the TIMER is the leak.
    const { storage } = makeStorage();
    let release!: (r: Response) => void;
    let requested = false;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const original = globalThis.fetch;
    globalThis.fetch = (() => { requested = true; return pending; }) as typeof globalThis.fetch;
    try {
      const owned = TokenRegistry.create({ remoteUrl: URL_A, storage, autoRefresh: true });
      for (let i = 0; i < 200 && !requested; i++) await new Promise((r) => setTimeout(r, 1));
      expect(requested).toBe(true);

      owned.dispose();
      release(new Response(JSON.stringify(defsA), { status: 200 }));
      await new Promise((r) => setTimeout(r, 50));

      // If the continuation armed an interval, the process now holds a live timer.
      expect(hasLiveInterval(owned)).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('startAutoRefresh after dispose arms nothing', async () => {
    const { storage } = makeStorage();
    const f = stubFetch();
    try {
      const owned = TokenRegistry.create({ remoteUrl: URL_A, storage, autoRefresh: false });
      owned.dispose();
      owned.startAutoRefresh(1000);
      expect(hasLiveInterval(owned)).toBe(false);
    } finally {
      f.restore();
    }
  });
  it('waitForReady leaves no timer behind when the load wins the race', async () => {
    // Promise.race does not cancel the loser. An unreferenced setTimeout still holds
    // Node's event loop open for its full duration — with the 10s default, well past
    // the point the registry has been disposed.
    vi.useFakeTimers();
    const { storage } = makeStorage();
    const f = stubFetch();
    try {
      const owned = TokenRegistry.create({ remoteUrl: URL_A, storage, autoRefresh: false });
      const before = vi.getTimerCount();
      await owned.waitForReady(10_000);
      expect(vi.getTimerCount()).toBe(before);
    } finally {
      f.restore();
    }
  });
  it('dispose ABORTS an in-flight fetch rather than merely ignoring its result', async () => {
    // Discarding the promise reference is not enough: the request and its 10s abort timer
    // both keep Node's event loop alive until the timeout elapses, long after teardown.
    const { storage } = makeStorage();
    let aborted = false;
    let requested = false;
    const original = globalThis.fetch;
    globalThis.fetch = ((_input: unknown, init?: { signal?: AbortSignal }) => {
      requested = true;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
      });
    }) as typeof globalThis.fetch;
    try {
      const owned = TokenRegistry.create({ remoteUrl: URL_A, storage, autoRefresh: true });
      for (let i = 0; i < 200 && !requested; i++) await new Promise((r) => setTimeout(r, 1));
      expect(requested).toBe(true); // vacuous if the fetch never started

      owned.dispose();
      await new Promise((r) => setTimeout(r, 20));
      expect(aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});

/**
 * The STATIC teardown path. `resetInstance()` used to call only `stopAutoRefresh()`,
 * which clears the interval but leaves `disposed` unset, the generation unchanged and
 * the request already in the air still running — so a load past its entry guard re-armed
 * the interval on an instance `getInstance()` could no longer return, and the fetch plus
 * its 10s abort timer went on holding Node's event loop open. Clearing the timer is the
 * half the old code got right, so the timer assertion alone cannot see the defect: the
 * abort, the disposed flag and the refusal to re-arm are what separate the two.
 */
describe('TokenRegistry.resetInstance', () => {
  it('disposes the outgoing singleton: interval cleared, in-flight fetch aborted, no re-arm', async () => {
    vi.useFakeTimers();
    const { storage } = makeStorage();
    // The first fetch answers at once (so the interval really gets armed); every later
    // one hangs until aborted, so a request is genuinely in the air at teardown.
    const calls: string[] = [];
    let aborted = 0;
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: { signal?: AbortSignal }) => {
      calls.push(String(input));
      if (calls.length === 1) {
        return Promise.resolve(new Response(JSON.stringify(defsA), { status: 200 }));
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborted++;
          reject(new Error('aborted'));
        });
      });
    }) as typeof globalThis.fetch;

    try {
      TokenRegistry.configure({ remoteUrl: URL_A, storage, autoRefresh: true, refreshIntervalMs: 1000 });
      const registry = TokenRegistry.getInstance();
      await vi.advanceTimersByTimeAsync(0);
      expect(hasLiveInterval(registry)).toBe(true);

      // One interval tick later a second fetch is in the air and never settles.
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.length).toBe(2);
      const timersBefore = vi.getTimerCount();
      expect(timersBefore).toBeGreaterThan(0);

      TokenRegistry.resetInstance();

      expect(registry.isDisposed).toBe(true);
      expect(hasLiveInterval(registry)).toBe(false);
      expect(aborted).toBe(1);
      expect(vi.getTimerCount()).toBeLessThan(timersBefore);

      // Several intervals on, the discarded instance issues nothing.
      await vi.advanceTimersByTimeAsync(5000);
      expect(calls.length).toBe(2);

      // ...and nothing can re-arm it — the caller that still holds this reference is the
      // one getInstance() can no longer hand back, so its timer would be unstoppable.
      registry.startAutoRefresh(1000);
      expect(hasLiveInterval(registry)).toBe(false);
      expect(await registry.refreshFromRemote()).toBe(false);
      expect(calls.length).toBe(2);

      // Sanity: the singleton really was replaced, so this is not "reset did nothing".
      const next = TokenRegistry.getInstance();
      expect(next).not.toBe(registry);
      expect(next.isDisposed).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });
});
