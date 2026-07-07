/**
 * T-D8 regression tests for W11 originated-tag stamping in
 * AccountingModule. Mirrors the T-D7 payments and T-D9 swap test
 * pattern: verifies the direct `storage.set` call sites route through
 * the `setEntry` helper when the provider implements it, carrying the
 * expected OpLog entry type, and falls back to plain `set` otherwise.
 *
 * Scope: exercises `setStorageEntry` via a source-level invariant
 * (no raw `storage.set(<stamped-key>, …)` or `storage.set(<scoped-key>,
 * …)` in `_persistLedgerForInvoice`) plus a behavioural test of a
 * local copy of the dispatcher. AccountingModule has a heavy
 * dependency surface (payments / communications / cid-ref-store)
 * which makes a full-module integration test impractical — the
 * grep-based guard catches regressions where a future edit
 * reintroduces a raw `storage.set` on the stamped keys.
 *
 * Classification matrix (see SPEC §10.2.3 and
 * profile/aggregator-pointer/originated-tag.ts):
 *
 *   key                                call site                         entryType
 *   ─────────────────────────────────  ────────────────────────────────  ──────────────
 *   FROZEN_BALANCES                    load() reconciliation             cache_index
 *   FROZEN_BALANCES                    closeInvoice() / cancelInvoice()  cache_index
 *   FROZEN_BALANCES                    _terminateInvoice()               cache_index
 *   FROZEN_BALANCES                    _persistFrozenBalances() helper   cache_index
 *   CLOSED_INVOICES                    closeInvoice()                    invoice_close
 *   CLOSED_INVOICES                    _terminateInvoice(CLOSED)         invoice_close
 *   CLOSED_INVOICES                    _persistTerminalSets() helper     cache_index
 *   CANCELLED_INVOICES                 cancelInvoice()                   invoice_cancel
 *   CANCELLED_INVOICES                 _terminateInvoice(CANCELLED)      invoice_cancel
 *   CANCELLED_INVOICES                 _persistTerminalSets() helper     cache_index
 *   AUTO_RETURN                        _persistAutoReturnSettings()      cache_index
 *   TOKEN_SCAN_STATE                   _flushDirtyLedgerEntries() step 2 cache_index
 *   INV_LEDGER_INDEX                   _flushDirtyLedgerEntries() step 3 cache_index
 *   inv_ledger:{invoiceId}             _persistLedgerForInvoice()        invoice_pay
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ACCOUNTING_MODULE_PATH = path.resolve(
  __dirname,
  '../../../modules/accounting/AccountingModule.ts',
);

describe('T-D8 AccountingModule W11 stamping — source-level invariant', () => {
  const source = fs.readFileSync(ACCOUNTING_MODULE_PATH, 'utf8');

  // These keys represent user actions (terminal-set commits,
  // ledger payments) and system housekeeping state that must carry
  // an explicit originated tag. A future regression that reintroduces
  // `storage.set(<key>, …)` fails this test.
  const W11_STAMPED_KEYS: readonly string[] = [
    'STORAGE_KEYS_ADDRESS.FROZEN_BALANCES',
    'STORAGE_KEYS_ADDRESS.CLOSED_INVOICES',
    'STORAGE_KEYS_ADDRESS.CANCELLED_INVOICES',
    'STORAGE_KEYS_ADDRESS.AUTO_RETURN',
    'STORAGE_KEYS_ADDRESS.TOKEN_SCAN_STATE',
    'STORAGE_KEYS_ADDRESS.INV_LEDGER_INDEX',
  ];

  for (const key of W11_STAMPED_KEYS) {
    it(`${key} is not written via raw storage.set (W11 routing guard)`, () => {
      const escapedKey = key.replace(/[.]/g, '\\.');
      // Match `storage.set(...KEY...` where KEY appears in the first
      // argument — catches raw set calls that pass the stamped constant
      // directly. The migrated call sites go through saveJsonToStorage
      // or setStorageEntry instead.
      const offenderRe = new RegExp(
        `storage\\s*\\.\\s*set\\s*\\([^)]*${escapedKey}`,
      );
      const lines = source.split('\n');
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        if (offenderRe.test(lines[i])) {
          offenders.push(`line ${i + 1}: ${lines[i].trim()}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it('per-invoice ledger writes (inv_ledger prefix) do not use raw storage.set', () => {
    // `_persistLedgerForInvoice` writes inv_ledger:{invoiceId} — the
    // key is built from INV_LEDGER_PREFIX and scoped via getStorageKey
    // before being passed to storage. A regression that reverts the
    // three migrated paths (cached ref, new ref, legacy inline) to
    // `storage.set` would re-introduce raw writes here.
    const persistBlockRe = /private\s+async\s+_persistLedgerForInvoice\s*\([\s\S]+?^\s{2}\}/m;
    const match = source.match(persistBlockRe);
    expect(match).not.toBeNull();
    const body = match![0];
    // Inside the helper, no direct storage.set calls — everything
    // should route through this.setStorageEntry.
    expect(body).not.toMatch(/storage\s*\.\s*set\s*\(/);
    // And the helper must invoke setStorageEntry for all three paths.
    const setStorageEntryCount = (body.match(/this\.setStorageEntry\s*\(/g) ?? []).length;
    expect(setStorageEntryCount).toBeGreaterThanOrEqual(3);
  });

  it('setStorageEntry helper is present at the expected class location', () => {
    // Anchor the helper so a future refactor (rename / move) trips
    // this test rather than silently losing stamping.
    expect(source).toMatch(/private\s+async\s+setStorageEntry\s*\(/);
    // Narrow union covers the three invoice user-action edges plus
    // cache_index. TypeScript catches unknown tags at compile time;
    // this grep pins the declared surface.
    expect(source).toMatch(/entryType:\s*['"]invoice_pay['"]\s*\|/);
    expect(source).toMatch(/['"]invoice_close['"]/);
    expect(source).toMatch(/['"]invoice_cancel['"]/);
    expect(source).toMatch(/['"]cache_index['"]/);
  });

  it('saveJsonToStorage dispatcher accepts entryType and routes through setStorageEntry', () => {
    // Ensures the central dispatcher's signature was widened in T-D8
    // (rather than bypassed by adding a separate code path).
    const signatureRe = /private\s+async\s+saveJsonToStorage\s*\(\s*key:\s*string,\s*value:\s*unknown,\s*entryType:/;
    expect(source).toMatch(signatureRe);
    // Dispatcher body must forward to setStorageEntry.
    const bodyRe = /private\s+async\s+saveJsonToStorage\s*\([\s\S]+?^\s{2}\}/m;
    const match = source.match(bodyRe);
    expect(match).not.toBeNull();
    expect(match![0]).toMatch(/this\.setStorageEntry\s*\(/);
  });

  it('every setStorageEntry call uses one of the declared entry types', () => {
    // TypeScript catches mismatches at compile time, but the grep pin
    // catches any future widening of the union that slips a new tag
    // into a call site without updating the declared set. Scan both
    // direct `setStorageEntry(...)` sites (in _persistLedgerForInvoice)
    // and the dispatcher-invoked path (via saveJsonToStorage, which
    // also passes the entryType string through).
    //
    // We match calls whose LAST positional string-literal argument is
    // the entryType. `[\s\S]` matches across newlines.
    const calls = [
      ...source.matchAll(
        /setStorageEntry\s*\([\s\S]*?,\s*['"]([a-z_]+)['"]\s*,?\s*\)/g,
      ),
    ];
    const tags = calls.map((m) => m[1]);
    const allowed = new Set([
      'invoice_pay',
      'invoice_close',
      'invoice_cancel',
      'cache_index',
    ]);
    for (const tag of tags) {
      expect(allowed.has(tag), `unexpected entryType: ${tag}`).toBe(true);
    }
    // Sanity: at least 3 invoice_pay sites (cached ref / new ref /
    // legacy inline in _persistLedgerForInvoice).
    const invoicePay = tags.filter((t) => t === 'invoice_pay').length;
    expect(invoicePay).toBeGreaterThanOrEqual(3);
  });

  it('every saveJsonToStorage call-site passes a declared entryType literal', () => {
    // All 13 call sites in AccountingModule must pass entryType as a
    // string literal (TypeScript could also accept a computed value,
    // but we pin to literals so the classification is readable in
    // diffs and greppable for audits).
    const calls = [
      ...source.matchAll(
        /saveJsonToStorage\s*\([\s\S]*?,\s*['"]([a-z_]+)['"]\s*,?\s*\)/g,
      ),
    ];
    const tags = calls.map((m) => m[1]);
    const allowed = new Set([
      'invoice_close',
      'invoice_cancel',
      'cache_index',
    ]);
    for (const tag of tags) {
      expect(allowed.has(tag), `unexpected entryType at saveJsonToStorage call: ${tag}`).toBe(true);
    }
    // Sanity: expect at least one invoice_close, one invoice_cancel,
    // and multiple cache_index sites.
    expect(tags.filter((t) => t === 'invoice_close').length).toBeGreaterThanOrEqual(1);
    expect(tags.filter((t) => t === 'invoice_cancel').length).toBeGreaterThanOrEqual(1);
    expect(tags.filter((t) => t === 'cache_index').length).toBeGreaterThanOrEqual(5);
  });

  it('_w11FallbackLogged static dedup set is declared', () => {
    // Anchor the fallback-logging dedup mechanism so a regression that
    // removes it (and thus re-introduces log spam on every write) is
    // caught. The set must be static-private per the T-D9 pattern.
    expect(source).toMatch(/private\s+static\s+_w11FallbackLogged\s*:\s*Set<string>/);
  });
});

describe('T-D8 setStorageEntry helper — dispatcher behaviour', () => {
  // Simulate the helper's dispatch logic directly. Keeps the test
  // decoupled from AccountingModule's heavy dependency surface while
  // pinning the contract: setEntry is preferred when available, set
  // is the fallback.
  async function setStorageEntry(
    storage: {
      set: (k: string, v: string) => Promise<void>;
      setEntry?: (k: string, v: string, t: string) => Promise<void>;
    },
    key: string,
    value: string,
    entryType: string,
  ): Promise<void> {
    if (typeof storage.setEntry === 'function') {
      await storage.setEntry(key, value, entryType);
    } else {
      await storage.set(key, value);
    }
  }

  it('routes to setEntry with invoice_pay when available', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'inv_ledger:abc', '{}', 'invoice_pay');
    expect(setEntry).toHaveBeenCalledWith('inv_ledger:abc', '{}', 'invoice_pay');
    expect(set).not.toHaveBeenCalled();
  });

  it('routes to setEntry with invoice_close when available', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'closed_invoices', '[]', 'invoice_close');
    expect(setEntry).toHaveBeenCalledWith('closed_invoices', '[]', 'invoice_close');
    expect(set).not.toHaveBeenCalled();
  });

  it('routes to setEntry with invoice_cancel when available', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'cancelled_invoices', '[]', 'invoice_cancel');
    expect(setEntry).toHaveBeenCalledWith('cancelled_invoices', '[]', 'invoice_cancel');
    expect(set).not.toHaveBeenCalled();
  });

  it('routes to setEntry with cache_index for housekeeping keys', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    const setEntry = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set, setEntry }, 'frozen_balances', '{}', 'cache_index');
    expect(setEntry).toHaveBeenCalledWith('frozen_balances', '{}', 'cache_index');
  });

  it('falls back to set when setEntry is absent', async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    await setStorageEntry({ set }, 'inv_ledger:abc', '{}', 'invoice_pay');
    expect(set).toHaveBeenCalledWith('inv_ledger:abc', '{}');
  });
});
