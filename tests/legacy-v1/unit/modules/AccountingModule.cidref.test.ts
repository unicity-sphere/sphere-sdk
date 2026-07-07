/**
 * AccountingModule — invoice ledger CID-ref persistence tests
 * (PROFILE-CID-REFERENCES.md §8.3).
 *
 * The invoice ledger is per-invoice partitioned (one KV key per invoiceId)
 * with Pattern A CID-refs. This test suite exercises the read/write paths
 * directly via `_flushDirtyLedgerEntries` (write) and `load()` (read).
 *
 * Covers:
 *   1. Write: CID ref envelope stored when cidRefStore is injected
 *   2. Read:  dual-read — CID ref fetched from IPFS on load
 *   3. Read:  legacy inline JSON still parses (migration window)
 *   4. Fallback: inline JSON retained when cidRefStore is absent
 *   5. Memoization: identical entries reuse cached ref (no re-pin)
 *   6. Memoization is per-invoice (no cross-contamination across invoices)
 *   7. Config error: ref present + no cidRefStore → CID_REF_UNREADABLE
 *   8. OpLog size: ref is constant-small regardless of entry count
 *   9. Corrupt legacy JSON → reset invoice map (non-exception path preserved)
 *   10. Non-object legacy data → reset invoice map (corruption visibility)
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTestAccountingModule,
} from './accounting-test-helpers.js';
import type { AccountingModule } from '../../../modules/accounting/AccountingModule.js';
import type {
  TestAccountingModuleMocks,
} from './accounting-test-helpers.js';
import type {
  InvoiceTransferRef,
  AccountingModuleDependencies,
} from '../../../modules/accounting/types.js';

// =============================================================================
// Helpers
// =============================================================================

/** Fake CidRefStore backed by an in-memory IPFS map. Uses real base32-encoded
 *  CIDs so `tryParseRef` (which calls CID.parse) accepts them. */
function makeFakeCidRefStore() {
  const ipfsStore = new Map<string, unknown>();
  const FAKE_CIDS = [
    'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
    'bafkreif4jkpxy2j7hezb2kjfb2mk23wsq5s7vzlqfkwnofkcfxsikiznna',
    'bafkreihjkz4shxhcbw2dsvsplsx5bwjv4uibkivyu3vzmhcuhaibcmxpau',
    'bafkreibnx2xlk3nv6r5tmsdtp3kvo5j2zh5y3qhqnvp7z4z5yblcvchyqu',
    'bafkreigc7s4sqhn7y7qdmkshxswfucacvalvb7r6i57sxa3gngkxm7pwdq',
  ];
  let nextCid = 0;
  const fakeStore = {
    pinJson: vi.fn(async (value: unknown) => {
      const cid = FAKE_CIDS[nextCid % FAKE_CIDS.length]!;
      nextCid += 1;
      ipfsStore.set(cid, value);
      const json = JSON.stringify(value);
      return {
        v: 1 as const,
        cid,
        size: new TextEncoder().encode(json).byteLength + 28,
        ts: Date.now(),
      };
    }),
    fetchJson: vi.fn(async (ref: { cid: string }) => {
      const data = ipfsStore.get(ref.cid);
      if (data === undefined) throw new Error(`CID not found: ${ref.cid}`);
      return data;
    }),
  };
  return { fakeStore, ipfsStore };
}

function makeTransferRef(id: string, coinId = 'UCT_HEX'): InvoiceTransferRef {
  return {
    transferId: `${id}:0`,
    coinId,
    amount: '1000000',
    paymentDirection: 'forward',
    timestamp: 1700000000000,
    fromPubkey: '02' + 'aa'.repeat(32),
    toAddress: 'DIRECT://recipient',
  } as unknown as InvoiceTransferRef;
}

/** Seed ledger state directly so we don't need the full mint path. */
function seedLedger(
  module: AccountingModule,
  invoiceId: string,
  entries: Record<string, InvoiceTransferRef>,
): void {
  const outer = (module as any).invoiceLedger as Map<string, Map<string, InvoiceTransferRef>>;
  const dirty = (module as any).dirtyLedgerEntries as Set<string>;
  const inner = new Map<string, InvoiceTransferRef>();
  for (const [k, v] of Object.entries(entries)) inner.set(k, v);
  outer.set(invoiceId, inner);
  dirty.add(invoiceId);
}

function getStorageKey(module: AccountingModule, suffix: string): string {
  return (module as any).getStorageKey(suffix);
}

// =============================================================================
// Tests
// =============================================================================

describe('AccountingModule — invoice ledger CID-ref persistence', () => {
  let module: AccountingModule;
  let mocks: TestAccountingModuleMocks;

  beforeEach(async () => {
    ({ module, mocks } = createTestAccountingModule());
    await module.load();
  });

  afterEach(() => {
    module.destroy();
    vi.restoreAllMocks();
  });

  it('writes CID ref envelope when cidRefStore is injected', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    (module as any).deps.cidRefStore = fakeStore;

    const invoiceId = 'inv_01';
    seedLedger(module, invoiceId, {
      'tx0::UCT_HEX': makeTransferRef('tx0'),
    });

    await (module as any)._flushDirtyLedgerEntries();

    const kvKey = getStorageKey(module, `inv_ledger:${invoiceId}`);
    const kvData = mocks.storage._data.get(kvKey);
    expect(kvData).toBeDefined();
    // KV must NOT contain the raw entries — they're on IPFS now.
    expect(kvData).not.toContain('tx0');
    const parsed = JSON.parse(kvData!);
    expect(parsed.v).toBe(1);
    expect(parsed.cid).toMatch(/^baf/);
    expect(parsed.size).toBeGreaterThan(0);
    expect(parsed.ts).toBeGreaterThan(0);
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1);
  });

  it('loads CID ref from KV and fetches entries from IPFS', async () => {
    const { fakeStore, ipfsStore } = makeFakeCidRefStore();

    // Seed IPFS + index + KV with a ref envelope, simulating a prior run.
    const invoiceId = 'inv_02';
    const entries = { 'tx0::UCT_HEX': makeTransferRef('tx0') };
    const prePinCid = 'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze';
    ipfsStore.set(prePinCid, entries);

    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger_index`),
      JSON.stringify({ [invoiceId]: { terminated: false } }),
    );
    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger:${invoiceId}`),
      JSON.stringify({ v: 1, cid: prePinCid, size: 1000, ts: 1700000000000 }),
    );

    // Recreate the module with cidRefStore so load() uses the dual-read path.
    module.destroy();
    ({ module, mocks: mocks } = createTestAccountingModule({ storage: mocks.storage }));
    (module as any).deps.cidRefStore = fakeStore;
    await module.load();

    const outer = (module as any).invoiceLedger as Map<string, Map<string, InvoiceTransferRef>>;
    expect(outer.get(invoiceId)?.has('tx0::UCT_HEX')).toBe(true);
    expect(fakeStore.fetchJson).toHaveBeenCalledTimes(1);
  });

  it('reads legacy inline JSON when cidRefStore is provided (migration)', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    const invoiceId = 'inv_legacy';

    // Seed legacy inline entries + index.
    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger_index`),
      JSON.stringify({ [invoiceId]: { terminated: false } }),
    );
    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger:${invoiceId}`),
      JSON.stringify({ 'txL::UCT_HEX': makeTransferRef('txL') }),
    );

    module.destroy();
    ({ module, mocks: mocks } = createTestAccountingModule({ storage: mocks.storage }));
    (module as any).deps.cidRefStore = fakeStore;
    await module.load();

    const outer = (module as any).invoiceLedger as Map<string, Map<string, InvoiceTransferRef>>;
    expect(outer.get(invoiceId)?.has('txL::UCT_HEX')).toBe(true);
    // fetchJson NOT called — tryParseRef returned null, legacy path taken.
    expect(fakeStore.fetchJson).not.toHaveBeenCalled();
  });

  it('inline JSON fallback when cidRefStore is absent', async () => {
    // No cidRefStore assigned.
    const invoiceId = 'inv_plain';
    seedLedger(module, invoiceId, {
      'tx0::UCT_HEX': makeTransferRef('tx0'),
    });

    await (module as any)._flushDirtyLedgerEntries();

    const kvKey = getStorageKey(module, `inv_ledger:${invoiceId}`);
    const kvData = mocks.storage._data.get(kvKey);
    expect(kvData).toBeDefined();
    // Plain object (NOT a ref envelope).
    const parsed = JSON.parse(kvData!);
    expect(parsed.v).toBeUndefined();
    expect(parsed['tx0::UCT_HEX']).toBeDefined();
  });

  it('memoizes identical entries and skips re-pin', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    (module as any).deps.cidRefStore = fakeStore;

    const invoiceId = 'inv_memo';
    seedLedger(module, invoiceId, {
      'tx0::UCT_HEX': makeTransferRef('tx0'),
    });

    await (module as any)._flushDirtyLedgerEntries();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1);

    // Flush again with same entries — memo hit, no second pin.
    (module as any).dirtyLedgerEntries.add(invoiceId);
    await (module as any)._flushDirtyLedgerEntries();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(1);
  });

  it('memoization is per-invoice (different invoices pin independently)', async () => {
    const { fakeStore } = makeFakeCidRefStore();
    (module as any).deps.cidRefStore = fakeStore;

    seedLedger(module, 'inv_A', { 'tx0::UCT_HEX': makeTransferRef('tx0') });
    seedLedger(module, 'inv_B', { 'tx1::UCT_HEX': makeTransferRef('tx1') });

    await (module as any)._flushDirtyLedgerEntries();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(2);

    // Re-flush only inv_A with identical content — memo hit for A, B untouched.
    (module as any).dirtyLedgerEntries.add('inv_A');
    await (module as any)._flushDirtyLedgerEntries();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(2); // no new pin

    // Now mutate inv_B and re-flush it — fresh pin for B, A's memo intact.
    const inner = (module as any).invoiceLedger.get('inv_B')! as Map<string, InvoiceTransferRef>;
    inner.set('tx2::UCT_HEX', makeTransferRef('tx2'));
    (module as any).dirtyLedgerEntries.add('inv_B');
    await (module as any)._flushDirtyLedgerEntries();
    expect(fakeStore.pinJson).toHaveBeenCalledTimes(3); // fresh pin for B
  });

  it('throws CID_REF_UNREADABLE when ref present but cidRefStore absent', async () => {
    const invoiceId = 'inv_orphan_ref';

    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger_index`),
      JSON.stringify({ [invoiceId]: { terminated: false } }),
    );
    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger:${invoiceId}`),
      JSON.stringify({
        v: 1,
        cid: 'bafkreieyqvmjr6zq5adijx2kzlcfmdvexmy2i6knyj4w2pybmzxmvg6bze',
        size: 100,
        ts: 1700000000000,
      }),
    );

    // Fresh module with NO cidRefStore — load must propagate the error so
    // the existing corruption handler can reset the invoice ledger and
    // rescan on-chain. The throw is caught by the outer try/catch in the
    // load's Phase 1b loop.
    module.destroy();
    ({ module, mocks: mocks } = createTestAccountingModule({ storage: mocks.storage }));
    // Deliberately NOT assigning cidRefStore.
    await module.load();

    // The corruption handler at the load call site resets the invoice ledger
    // on parse failure. CID_REF_UNREADABLE is caught there as a corruption
    // signal — the entry is reset (rescan will rebuild).
    const inner = (module as any).invoiceLedger.get(invoiceId) as Map<string, InvoiceTransferRef>;
    expect(inner?.size ?? 0).toBe(0);
  });

  it('OpLog value shrinks dramatically when CidRefStore is used', async () => {
    // Write 50 entries inline first to measure fat-size.
    const invoiceId = 'inv_size';
    const bigEntries: Record<string, InvoiceTransferRef> = {};
    for (let i = 0; i < 50; i++) {
      bigEntries[`tx${i}::UCT_HEX`] = makeTransferRef(`tx${i}`);
    }
    seedLedger(module, invoiceId, bigEntries);
    await (module as any)._flushDirtyLedgerEntries();
    const kvKey = getStorageKey(module, `inv_ledger:${invoiceId}`);
    const inlineSize = mocks.storage._data.get(kvKey)!.length;
    expect(inlineSize).toBeGreaterThan(2_000);

    // Inject cidRefStore + mutate + re-flush. Bust memo with a new entry.
    const { fakeStore } = makeFakeCidRefStore();
    (module as any).deps.cidRefStore = fakeStore;
    const inner = (module as any).invoiceLedger.get(invoiceId)! as Map<string, InvoiceTransferRef>;
    inner.set('tx_new::UCT_HEX', makeTransferRef('tx_new'));
    (module as any).dirtyLedgerEntries.add(invoiceId);
    await (module as any)._flushDirtyLedgerEntries();

    const refSize = mocks.storage._data.get(kvKey)!.length;
    expect(refSize).toBeLessThan(300);
    expect(refSize).toBeLessThan(inlineSize);
  });

  it('corrupt legacy JSON → invoice ledger reset (non-exception path)', async () => {
    const invoiceId = 'inv_corrupt';

    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger_index`),
      JSON.stringify({ [invoiceId]: { terminated: false } }),
    );
    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger:${invoiceId}`),
      '{corrupt json without quotes}',
    );

    module.destroy();
    ({ module, mocks: mocks } = createTestAccountingModule({ storage: mocks.storage }));
    await module.load();

    // Load's corruption handler resets the inner map; pre-existing behavior.
    const outer = (module as any).invoiceLedger as Map<string, Map<string, InvoiceTransferRef>>;
    const inner = outer.get(invoiceId);
    expect(inner?.size ?? 0).toBe(0);
  });

  it('non-object legacy data → invoice ledger reset (corruption visibility)', async () => {
    const invoiceId = 'inv_nonobject';

    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger_index`),
      JSON.stringify({ [invoiceId]: { terminated: false } }),
    );
    // Parses, but is an ARRAY (not Record<string, InvoiceTransferRef>).
    mocks.storage._data.set(
      getStorageKey(module, `inv_ledger:${invoiceId}`),
      JSON.stringify(['not', 'an', 'object']),
    );

    module.destroy();
    ({ module, mocks: mocks } = createTestAccountingModule({ storage: mocks.storage }));
    await module.load();

    const inner = (module as any).invoiceLedger.get(invoiceId) as Map<string, InvoiceTransferRef>;
    expect(inner?.size ?? 0).toBe(0);
  });
});
