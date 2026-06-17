/**
 * C1 (L1 removal, step 1) — storage address-guard migration to chainPubkey.
 *
 * Token-storage metadata (`_meta.address`) used to persist `identity.l1Address`
 * (an `alpha1...` value) and the PaymentsModule load/sync address guards rejected
 * data whose `_meta.address` did not match. With L1 being removed, writes now
 * persist `identity.chainPubkey` and the read-side guards must:
 *   1. still LOAD wallets whose stored `_meta.address` is a LEGACY `alpha1...`
 *      value (migration safety — existing wallets must not lose tokens), AND
 *   2. still REJECT data persisted under a DIFFERENT chainPubkey (#579 anti-
 *      cross-address-contamination protection preserved), AND
 *   3. WRITE `identity.chainPubkey` (never an `alpha1` value) on save.
 *
 * The token store is physically partitioned by chainPubkey (DB name /
 * dir / kv namespace), so legacy-alpha1 tolerance cannot resurrect cross-address
 * contamination — `_meta.address` is a secondary guard, and legacy records are
 * rewritten to chainPubkey on the next save.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createPaymentsModule, type PaymentsModuleDependencies } from '../../../modules/payments/PaymentsModule';
import type { FullIdentity } from '../../../types';
import type { TransportProvider } from '../../../transport';
import type { OracleProvider } from '../../../oracle';
import type { StorageProvider, TokenStorageProvider, TxfStorageDataBase, HistoryRecord } from '../../../storage';
import { FakeTokenEngine } from '../token-engine/FakeTokenEngine';
import { testIdentity } from '../../support/wallet-api-test-helpers';
import { hexToBytes } from '../../../core/crypto';

const UCT = '11'.repeat(32);
const SELF = testIdentity(31);

function fullIdentity(id: { privateKey: string; chainPubkey: string }): FullIdentity {
  return {
    chainPubkey: id.chainPubkey,
    privateKey: id.privateKey,
    l1Address: `alpha1${id.chainPubkey.slice(0, 8)}`,
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

function mockHistoryStore() {
  const entries = new Map<string, HistoryRecord>();
  return {
    addHistoryEntry: vi.fn(async (e: HistoryRecord) => { entries.set(e.dedupKey, e); }),
    getHistoryEntries: vi.fn(async () => [...entries.values()]),
    hasHistoryEntry: vi.fn(async (k: string) => entries.has(k)),
    clearHistory: vi.fn(async () => entries.clear()),
    importHistoryEntries: vi.fn(async () => 0),
  };
}

/**
 * Local whole-blob provider mock that exposes the LAST saved TXF data so a test
 * can inspect `_meta.address` (assertion 3) and craft a tampered load result
 * (assertions 1 & 2).
 */
interface LocalProvider {
  provider: TokenStorageProvider<TxfStorageDataBase>;
  getSaved(): TxfStorageDataBase | null;
  setLoadData(data: TxfStorageDataBase | null): void;
}

function mockLocalTokenStorage(): LocalProvider {
  let saved: TxfStorageDataBase | null = null;
  let loadData: TxfStorageDataBase | null = null;
  const provider = {
    id: 'local', name: 'local', type: 'local',
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn().mockResolvedValue(undefined),
    isConnected: () => true, getStatus: () => 'connected', setIdentity: vi.fn(),
    initialize: vi.fn().mockResolvedValue(true), shutdown: vi.fn().mockResolvedValue(undefined),
    save: vi.fn(async (data: TxfStorageDataBase) => { saved = data; loadData = data; return { success: true, timestamp: 0 }; }),
    load: vi.fn(async () => (loadData
      ? { success: true, source: 'local', timestamp: 0, data: loadData }
      : { success: false, source: 'local', timestamp: 0 })),
    sync: vi.fn().mockResolvedValue({ success: true, added: 0, removed: 0, conflicts: 0 }),
    ...mockHistoryStore(),
  } as unknown as TokenStorageProvider<TxfStorageDataBase>;
  return {
    provider,
    getSaved: () => saved,
    setLoadData: (data) => { loadData = data; },
  };
}

function mockTransport(): TransportProvider {
  return {
    sendTokenTransfer: vi.fn().mockResolvedValue(undefined),
    onTokenTransfer: vi.fn().mockReturnValue(() => {}),
    onPaymentRequest: vi.fn().mockReturnValue(() => {}),
    onPaymentRequestResponse: vi.fn().mockReturnValue(() => {}),
    resolve: vi.fn().mockResolvedValue(null),
    resolveTransportPubkeyInfo: vi.fn().mockResolvedValue(null),
    connect: vi.fn().mockResolvedValue(undefined), disconnect: vi.fn(), isConnected: () => true,
  } as unknown as TransportProvider;
}

function mockOracle(): OracleProvider {
  return { validateToken: vi.fn().mockResolvedValue({ valid: true }), isDevMode: () => false } as unknown as OracleProvider;
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  vi.restoreAllMocks();
});

function makeDeps(local: LocalProvider): PaymentsModuleDependencies {
  return {
    identity: fullIdentity(SELF),
    storage: mockStorage(),
    tokenStorageProviders: new Map([[local.provider.id, local.provider]]),
    transport: mockTransport(),
    oracle: mockOracle(),
    emitEvent: vi.fn(),
    tokenEngine: new FakeTokenEngine({ chainPubkey: hexToBytes(SELF.chainPubkey) }),
  };
}

function initModule(deps: PaymentsModuleDependencies) {
  const module = createPaymentsModule({ l1: null });
  module.initialize(deps);
  cleanups.push(() => module.destroy());
  return module;
}

/**
 * Seed a real, serializable token into storage: mint one through a module (which
 * populates the token map AND triggers save into the mock provider, capturing
 * the real TXF data with `_meta.address`). Returns a deep-cloned copy of the
 * captured save data plus the number of tokens the seeding module held.
 */
async function seedSavedData(local: LocalProvider): Promise<{ data: TxfStorageDataBase; tokenCount: number }> {
  const module = initModule(makeDeps(local));
  await module.load();
  const mint = await module.mintFungibleToken(UCT, 1000n);
  expect(mint.success).toBe(true);
  const tokenCount = module.getTokens().length;
  expect(tokenCount).toBeGreaterThan(0);
  const saved = local.getSaved();
  expect(saved).not.toBeNull();
  // Deep clone so later mutations don't affect the live module's reference.
  return { data: JSON.parse(JSON.stringify(saved)) as TxfStorageDataBase, tokenCount };
}

describe('C1 storage address-guard migration (l1Address → chainPubkey)', () => {
  it('3) save persists _meta.address = identity.chainPubkey (never an alpha1 value)', async () => {
    const local = mockLocalTokenStorage();
    const { data } = await seedSavedData(local);
    expect(data._meta?.address).toBe(SELF.chainPubkey);
    expect(data._meta?.address?.startsWith('alpha1')).toBe(false);
  });

  it('1) a wallet whose stored _meta.address is a LEGACY alpha1 value still loads its tokens', async () => {
    // Seed real data via a throwaway provider, then replay it through a FRESH
    // module/provider after rewriting _meta.address to a legacy alpha1 value.
    const { data: seeded, tokenCount } = await seedSavedData(mockLocalTokenStorage());

    const legacy = JSON.parse(JSON.stringify(seeded)) as TxfStorageDataBase;
    legacy._meta!.address = 'alpha1legacyaddressvaluefromoldwallet';

    const fresh = mockLocalTokenStorage();
    fresh.setLoadData(legacy);
    const module = initModule(makeDeps(fresh));
    await module.load();

    const loaded = module.getTokens();
    expect(loaded.length).toBe(tokenCount);
    expect(loaded.some((t) => t.coinId === UCT && t.amount === '1000')).toBe(true);
  });

  it('2) data whose _meta.address is a DIFFERENT chainPubkey is still rejected (#579 preserved)', async () => {
    const { data: seeded, tokenCount } = await seedSavedData(mockLocalTokenStorage());
    expect(tokenCount).toBeGreaterThan(0);

    const foreign = JSON.parse(JSON.stringify(seeded)) as TxfStorageDataBase;
    // A chainPubkey-format value that is NOT this wallet's (a different HD address).
    foreign._meta!.address = '03' + 'ab'.repeat(32);
    expect(foreign._meta!.address).not.toBe(SELF.chainPubkey);
    expect(foreign._meta!.address.startsWith('alpha1')).toBe(false);

    const fresh = mockLocalTokenStorage();
    fresh.setLoadData(foreign);
    const module = initModule(makeDeps(fresh));
    await module.load();

    // The whole record is rejected — none of its tokens enter the balance.
    expect(module.getTokens()).toHaveLength(0);
  });

  it('4) a record with an EMPTY-string _meta.address still loads its tokens (guard short-circuits on falsy address)', async () => {
    // Defensive: an (impossible-but-cheap-to-guard) empty _meta.address must not
    // trip the mismatch guard and cause mass token rejection / loss.
    const { data: seeded, tokenCount } = await seedSavedData(mockLocalTokenStorage());

    const empty = JSON.parse(JSON.stringify(seeded)) as TxfStorageDataBase;
    empty._meta!.address = '';

    const fresh = mockLocalTokenStorage();
    fresh.setLoadData(empty);
    const module = initModule(makeDeps(fresh));
    await module.load();

    const loaded = module.getTokens();
    expect(loaded.length).toBe(tokenCount);
    expect(loaded.some((t) => t.coinId === UCT && t.amount === '1000')).toBe(true);
  });
});
