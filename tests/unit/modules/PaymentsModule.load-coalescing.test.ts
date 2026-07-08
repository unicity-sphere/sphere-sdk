/**
 * load() single-flight (#642): the 30s inventory poll backstop and the
 * `inventory` wakes call load() via resyncInventory(); on a heavy wallet one
 * load can outlive the poll interval, and uncoalesced calls stacked concurrent
 * full loads — each re-running the complete history hydration (the swap-wallet
 * request storm: 84% of ~2,600 requests in 8 minutes were history pages).
 *
 * Same-owner concurrent calls now share the in-flight load, plus exactly ONE
 * trailing re-run so a wake that raced a load still converges.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase } from '../../../storage';
import { testIdentity } from '../../support/wallet-api-test-helpers';

const WHO = testIdentity(71);
const OTHER = testIdentity(72);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    directAddress: `DIRECT://${id.chainPubkey.slice(0, 12)}`,
    transportPubkey: id.chainPubkey.slice(2),
  };
}

function mockStorage(): StorageProvider {
  const s = new Map<string, string>();
  return {
    id: 's', name: 's', type: 'local', connect: vi.fn(), disconnect: vi.fn(),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    get: vi.fn(async (k: string) => s.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => { s.set(k, v); }),
    remove: vi.fn(async (k: string) => { s.delete(k); }),
    has: vi.fn(async (k: string) => s.has(k)),
    keys: vi.fn(async () => [...s.keys()]),
    clear: vi.fn(async () => { s.clear(); }),
  } as unknown as StorageProvider;
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn(), onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null), resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn(), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return { validateToken: vi.fn().mockResolvedValue({ valid: true }), isDevMode: () => false } as unknown as OracleProvider;
}

/**
 * A local token-storage provider whose load() blocks until `release()` —
 * concurrency is observable through `loadCalls`/`maxConcurrent`.
 */
function gatedTokenStorage() {
  let releaseAll: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releaseAll = resolve; });
  const stats = { loadCalls: 0, inFlight: 0, maxConcurrent: 0 };
  const provider = {
    id: 'local', name: 'local', type: 'local',
    connect: vi.fn(), disconnect: vi.fn(), isConnected: () => true,
    getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn(),
    save: vi.fn(async () => ({ success: true, timestamp: 0 })),
    load: vi.fn(async () => {
      stats.loadCalls++;
      stats.inFlight++;
      stats.maxConcurrent = Math.max(stats.maxConcurrent, stats.inFlight);
      await gate;
      stats.inFlight--;
      return { success: false, source: 'local', timestamp: 0 };
    }),
    sync: vi.fn(async () => ({ success: true, added: 0, removed: 0, conflicts: 0 })),
    getHistoryEntries: vi.fn(async () => []),
    addHistoryEntry: vi.fn(), hasHistoryEntry: vi.fn(async () => false),
    clearHistory: vi.fn(), importHistoryEntries: vi.fn(async () => 0),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
  return { provider, stats, release: () => releaseAll!() };
}

function makeDeps(
  provider: TokenStorageProvider<TxfStorageDataBase>,
  who: { privateKey: string; chainPubkey: string } = WHO,
): PaymentsModuleDependencies {
  return {
    identity: fullIdentity(who),
    storage: mockStorage(),
    tokenStorageProviders: new Map([['local', provider]]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent: vi.fn(),
  };
}

function makeModule(provider: TokenStorageProvider<TxfStorageDataBase>): {
  module: PaymentsModule;
  emitEvent: ReturnType<typeof vi.fn>;
} {
  const deps = makeDeps(provider);
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return { module, emitEvent: deps.emitEvent as ReturnType<typeof vi.fn> };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('PaymentsModule.load() — single-flight (#642)', () => {
  it('coalesces concurrent same-owner calls onto one provider load, never overlapping', async () => {
    const { provider, stats, release } = gatedTokenStorage();
    const { module } = makeModule(provider);

    const p1 = module.load();
    const p2 = module.load();
    const p3 = module.load();
    release();
    await Promise.all([p1, p2, p3]);

    expect(stats.maxConcurrent).toBe(1); // never two provider loads at once
    // The coalesced callers scheduled exactly ONE trailing re-run.
    await vi.waitFor(() => expect(stats.loadCalls).toBe(2));
    await new Promise((r) => setTimeout(r, 50));
    expect(stats.loadCalls).toBe(2); // ...and no more after it
  });

  it('the trailing re-run converges through resyncInventory — sync:remote-update fires after it', async () => {
    const { provider, stats, release } = gatedTokenStorage();
    const { module, emitEvent } = makeModule(provider);

    const p1 = module.load();
    const p2 = module.load(); // coalesced → requests the re-run
    release();
    await Promise.all([p1, p2]);
    expect(emitEvent).not.toHaveBeenCalledWith('sync:remote-update', expect.anything());

    // The re-run goes through resyncInventory(), which emits AFTER converging —
    // a bare load() would merge silently and the UI would miss the wake.
    await vi.waitFor(() => {
      expect(stats.loadCalls).toBe(2);
      expect(emitEvent).toHaveBeenCalledWith(
        'sync:remote-update',
        expect.objectContaining({ providerId: 'wallet-api', name: 'inventory' }),
      );
    });
  });

  it('does not coalesce sequential calls — each load runs fresh', async () => {
    const { provider, stats, release } = gatedTokenStorage();
    const { module } = makeModule(provider);
    release(); // no gating needed here

    await module.load();
    await module.load();
    expect(stats.loadCalls).toBe(2);
  });

  it('a coalesced caller resolves with the shared load completed (loaded state visible)', async () => {
    const { provider, release } = gatedTokenStorage();
    const { module } = makeModule(provider);

    const p1 = module.load();
    const p2 = module.load();
    let p2Done = false;
    void p2.then(() => { p2Done = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(p2Done).toBe(false); // blocked on the shared in-flight load

    release();
    await Promise.all([p1, p2]);
    expect(module.getTokens()).toEqual([]); // load completed for both callers
  });

  it('a different-owner call serializes behind the stale load and runs fresh', async () => {
    const gatedA = gatedTokenStorage();
    const { module } = makeModule(gatedA.provider);

    const pA = module.load(); // OWNER A's load, gated
    // Let A's load actually reach its (gated) provider call before switching.
    await vi.waitFor(() => expect(gatedA.stats.loadCalls).toBe(1));

    // Address switch mid-load: re-init with owner B and B's own provider.
    const providerB = gatedTokenStorage();
    providerB.release(); // B's loads answer immediately
    module.initialize(makeDeps(providerB.provider, OTHER));

    const pB = module.load();
    let pBDone = false;
    void pB.then(() => { pBDone = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(pBDone).toBe(false); // B waits behind A's stale in-flight load

    gatedA.release();
    await Promise.all([pA, pB]);
    expect(providerB.stats.loadCalls).toBeGreaterThanOrEqual(1); // fresh run under B
  });

  it('destroy() cancels a pending trailing re-run', async () => {
    const { provider, stats, release } = gatedTokenStorage();
    const { module } = makeModule(provider);

    const p1 = module.load();
    const p2 = module.load(); // marks the trailing re-run
    module.destroy();
    cleanups.pop(); // already destroyed
    release();
    await Promise.all([p1, p2]);

    await new Promise((r) => setTimeout(r, 50));
    expect(stats.loadCalls).toBe(1); // no re-run fired after destroy
  });

  it('destroy() right after a completed load cancels the already-scheduled re-run (consumed flag)', async () => {
    const { provider, stats, release } = gatedTokenStorage();
    const { module } = makeModule(provider);

    const p1 = module.load();
    const p2 = module.load(); // marks the trailing re-run
    release();
    await Promise.all([p1, p2]); // finally has consumed the flag into the timer
    module.destroy();
    cleanups.pop(); // already destroyed

    await new Promise((r) => setTimeout(r, 50));
    expect(stats.loadCalls).toBe(1); // the timer was cleared — no zombie load
  });
});
