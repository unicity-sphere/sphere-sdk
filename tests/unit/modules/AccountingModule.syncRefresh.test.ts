/**
 * AccountingModule — invoiceTermsCache refresh on sync:completed (issue #230)
 *
 * `PaymentsModule.sync()` pulls new tokens from Profile/IPFS providers via
 * `loadFromStorageData(result.merged)`, which intentionally bypasses
 * `addToken()` — so the `onTokenChange` observer never fires for
 * sync-imported invoice tokens. Without the `sync:completed` subscriber,
 * cross-device invoice propagation (Alice mints on peer1, peer2 receives
 * the invoice token via Profile sync) leaves `invoiceTermsCache` stale and
 * `getInvoiceStatus(invoiceId)` returns "No invoice found".
 *
 * These tests pin:
 *   1. New invoice tokens visible to PaymentsModule after sync ARE added
 *      to the cache and fire `invoice:created` with `confirmed: false`.
 *   2. Existing entries are NOT overwritten (the cache is also a
 *      write-through surface for locally-minted invoices).
 *   3. Already-cached IDs do NOT re-fire `invoice:created` on subsequent
 *      sync events — idempotent refresh.
 *   4. Non-invoice tokens (regular coin tokens) are ignored.
 *
 * @see https://github.com/unicity-sphere/sphere-sdk/issues/230
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createTestAccountingModule,
  createTestToken,
  INVOICE_TOKEN_TYPE_HEX,
} from './accounting-test-helpers.js';
import type { InvoiceTerms } from '../../../modules/accounting/types.js';
import type { Token } from '../../../types/index.js';

function makeTerms(suffix: string): InvoiceTerms {
  return {
    createdAt: Date.now(),
    targets: [
      {
        address: `DIRECT://target_${suffix}`,
        assets: [{ coin: ['UCT', '10000000'] }],
      },
    ],
    memo: `invoice-${suffix}`,
  };
}

function makeInvoiceUiToken(terms: InvoiceTerms): { id: string; uiToken: Token } {
  const txf = createTestToken(terms);
  const id = txf.genesis.data.tokenId;
  return {
    id,
    uiToken: {
      id,
      coinId: INVOICE_TOKEN_TYPE_HEX,
      symbol: 'INVOICE',
      name: 'Invoice',
      decimals: 0,
      amount: '0',
      status: 'confirmed',
      createdAt: terms.createdAt!,
      updatedAt: terms.createdAt!,
      sdkData: JSON.stringify(txf),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

describe('AccountingModule — sync:completed refreshes invoiceTermsCache (#230)', () => {
  let module: ReturnType<typeof createTestAccountingModule>['module'];
  let mocks: ReturnType<typeof createTestAccountingModule>['mocks'];
  let emitEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const built = createTestAccountingModule();
    module = built.module;
    mocks = built.mocks;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    emitEvent = (module as any).deps?.emitEvent as ReturnType<typeof vi.fn>;
    await module.load();
  });

  afterEach(() => {
    try {
      module.destroy();
    } catch {
      /* ignore */
    }
    vi.restoreAllMocks();
  });

  it('adds sync-discovered invoice tokens to the cache and fires invoice:created', async () => {
    // Cache starts empty (no invoice tokens at load time).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (module as any).invoiceTermsCache as Map<string, InvoiceTerms>;
    expect(cache.size).toBe(0);

    // Simulate sync pulling in a new invoice token from Profile/IPFS.
    const { id, uiToken } = makeInvoiceUiToken(makeTerms('peer1'));
    mocks.payments._tokens.push(uiToken);

    emitEvent.mockClear();
    mocks.payments._emit('sync:completed', { source: 'payments', count: 1 });

    // The handler is synchronous w.r.t. its impact on the cache.
    expect(cache.has(id)).toBe(true);
    expect(cache.get(id)!.memo).toBe('invoice-peer1');
    expect(emitEvent).toHaveBeenCalledWith(
      'invoice:created',
      { invoiceId: id, confirmed: false },
    );
  });

  it('does not re-emit invoice:created for an already-cached invoice on a second sync', async () => {
    const { uiToken } = makeInvoiceUiToken(makeTerms('peer1'));
    mocks.payments._tokens.push(uiToken);

    // First sync — discovery + emit.
    mocks.payments._emit('sync:completed', { source: 'payments', count: 1 });

    emitEvent.mockClear();

    // Second sync — same token still present, no new event.
    mocks.payments._emit('sync:completed', { source: 'payments', count: 1 });

    const created = emitEvent.mock.calls.filter(([evt]) => evt === 'invoice:created');
    expect(created).toHaveLength(0);
  });

  it('does not overwrite existing cache entries (locally-minted invoices keep their terms)', async () => {
    // Pre-seed the cache as if createInvoice() had just minted it — the
    // terms here are NOT what the on-disk token genesis would parse to,
    // so an overwrite would be observable.
    const localTerms = makeTerms('local');
    localTerms.memo = 'LOCAL_WRITE_THROUGH';

    const { id, uiToken } = makeInvoiceUiToken(makeTerms('peer1'));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (module as any).invoiceTermsCache.set(id, localTerms);

    // Now make PaymentsModule report the on-disk version (memo = invoice-peer1).
    mocks.payments._tokens.push(uiToken);

    emitEvent.mockClear();
    mocks.payments._emit('sync:completed', { source: 'payments', count: 1 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (module as any).invoiceTermsCache as Map<string, InvoiceTerms>;
    expect(cache.get(id)!.memo).toBe('LOCAL_WRITE_THROUGH');

    // And no `invoice:created` fires because the ID was already in the cache.
    const created = emitEvent.mock.calls.filter(([evt]) => evt === 'invoice:created');
    expect(created).toHaveLength(0);
  });

  it('ignores non-invoice tokens during the post-sync refresh', async () => {
    const coinToken: Token = {
      id: 'a'.repeat(64),
      coinId: 'UCT', // NOT INVOICE_TOKEN_TYPE_HEX
      symbol: 'UCT',
      name: 'Unicity Coin',
      decimals: 8,
      amount: '100000000',
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: JSON.stringify({
        genesis: {
          data: {
            tokenId: 'a'.repeat(64),
            tokenType: 'deadbeef', // arbitrary non-invoice type
            tokenData: '',
          },
        },
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    mocks.payments._tokens.push(coinToken);

    emitEvent.mockClear();
    mocks.payments._emit('sync:completed', { source: 'payments', count: 1 });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = (module as any).invoiceTermsCache as Map<string, InvoiceTerms>;
    expect(cache.size).toBe(0);

    const created = emitEvent.mock.calls.filter(([evt]) => evt === 'invoice:created');
    expect(created).toHaveLength(0);
  });

  it('rebuilds the hash index so resolveInvoiceRef can find the new invoice', async () => {
    const { id, uiToken } = makeInvoiceUiToken(makeTerms('peer1'));
    mocks.payments._tokens.push(uiToken);

    mocks.payments._emit('sync:completed', { source: 'payments', count: 1 });

    // Hash index should include the new ID. Look it up via resolveInvoiceRef
    // by computing the SHA-256 of the invoice id ourselves.
    const { hashInvoiceId } = await import('../../../modules/accounting/memo.js');
    const hash = hashInvoiceId(id);

    expect(module.resolveInvoiceRef(hash)).toBe(id);
  });
});
