/**
 * PaymentsModule getHistory() — Phase 6 v2 slim rebuild coverage.
 *
 * v2 records history entries via the send + handleIncomingTransfer paths.
 * The read surface is `getHistory()` (returns a defensive copy sorted
 * newest-first) plus the public `addToHistory()` seam consumers like
 * AccountingModule use to log invoice-attributed events.
 *
 * This suite locks in:
 *   - SENT entry shape after a real send(): amount, coinId, transferId,
 *     recipientNametag, recipientPubkey, recipientAddress, memo, tokenIds
 *     with the source discriminator ('direct' | 'split'), timestamp.
 *   - RECEIVED entry shape after handler ingest: amount aggregated across
 *     all bundle tokens, coinId+symbol from the first token, senderPubkey
 *     from the transport (not the payload), senderNametag from payload,
 *     senderAddress from resolveTransportPubkeyInfo, memo, recipientAddress
 *     from our own identity.directAddress, tokenIds.
 *   - Round-trip: N sends + M receives all appear in getHistory().
 *   - Sort order under a mix of manual addToHistory() + real activity.
 *   - getHistory() returns a defensive copy — mutating the returned array
 *     does not corrupt the underlying cache.
 *   - Public addToHistory() accepts entries without id/dedupKey.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../registry', () => ({
  TokenRegistry: {
    getInstance: () => ({
      getDefinition: () => null,
      getIconUrl: () => null,
      getSymbol: (id: string) => id,
      getName: (id: string) => id,
      getDecimals: () => 8,
    }),
    waitForReady: vi.fn().mockResolvedValue(undefined),
  },
}));

import {
  buildIncomingTransfer,
  DEFAULT_SENDER_DIRECT_ADDRESS,
  DEFAULT_SENDER_PUBKEY,
  DEFAULT_SENDER_TRANSPORT_PUBKEY,
  makeV2Harness,
  mint,
  resetTokenSeq,
} from './__fixtures__/v2-harness';
import type { TransactionHistoryEntry } from '../../../../modules/payments/PaymentsModule';

describe('PaymentsModule getHistory() (v2 slim)', () => {
  beforeEach(() => {
    resetTokenSeq();
  });

  it('SENT entry carries transferId + recipient fields + memo + tokenIds after a real send', async () => {
    const h = await makeV2Harness();
    await mint(h, 'UCT', 1_000n);

    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '250',
      memo: 'lunch',
    });
    expect(result.status).toBe('delivered');

    const history = h.module.getHistory();
    expect(history).toHaveLength(1);
    const sent = history[0];
    expect(sent.type).toBe('SENT');
    expect(sent.amount).toBe('250');
    expect(sent.coinId).toBe('UCT');
    expect(sent.transferId).toBe(result.id);
    expect(sent.recipientNametag).toBe('bob');
    expect(sent.recipientAddress).toBe('DIRECT://bob-address');
    expect(sent.memo).toBe('lunch');
    expect(Array.isArray(sent.tokenIds)).toBe(true);
    expect(sent.tokenIds!.length).toBe(1);
    expect(sent.tokenIds![0].source).toBe('direct');
  });

  it('RECEIVED entry carries sender + recipient + memo + aggregated amount', async () => {
    const h = await makeV2Harness();
    await h.handler(
      buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, {
        memo: 'INV:abc:F',
        tokenCount: 2,
        amount: 50n,
      }),
    );

    const history = h.module.getHistory();
    expect(history).toHaveLength(1);
    const rec = history[0];
    expect(rec.type).toBe('RECEIVED');
    // Aggregated across the two tokens.
    expect(rec.amount).toBe('100');
    expect(rec.coinId).toBe('UCT');
    expect(rec.senderPubkey).toBe(DEFAULT_SENDER_TRANSPORT_PUBKEY);
    expect(rec.senderNametag).toBe('alice');
    expect(rec.senderAddress).toBe(DEFAULT_SENDER_DIRECT_ADDRESS);
    expect(rec.recipientAddress).toBe('DIRECT://sender-abc');
    expect(rec.memo).toBe('INV:abc:F');
    expect(rec.tokenIds!.length).toBe(2);
  });

  it('SENT entries dedup by (transferId, coinId) — history has one row per coin per send', async () => {
    const h = await makeV2Harness();
    await mint(h, 'UCT', 1_000n);
    await mint(h, 'USDU', 2_000n);

    // A multi-coin send. v2 slim records one SENT row per send() (primary
    // coinId only). If the impl ever grows a per-coin row, this test locks
    // in the current shape so a future change is visible.
    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '500',
      additionalAssets: [{ kind: 'coin', coinId: 'USDU', amount: '250' }],
    });
    expect(result.status).toBe('delivered');
    const history = h.module.getHistory();
    // v2 slim records one SENT entry per send() call (primary coin only).
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('SENT');
    // The recorded row keys off the primary (request.coinId + request.amount).
    expect(history[0].coinId).toBe('UCT');
    expect(history[0].amount).toBe('500');
  });

  it('N sends + M receives interleave and both surface in getHistory()', async () => {
    const h = await makeV2Harness();
    await mint(h, 'UCT', 1_000n);
    await mint(h, 'UCT', 1_000n);

    await h.module.send({ recipient: '@bob', coinId: 'UCT', amount: '100' });
    await h.handler(buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, { eventId: 'r-1' }));
    await h.module.send({ recipient: '@bob', coinId: 'UCT', amount: '200' });
    await h.handler(buildIncomingTransfer(DEFAULT_SENDER_PUBKEY, { eventId: 'r-2' }));

    const history = h.module.getHistory();
    const sent = history.filter((e) => e.type === 'SENT');
    const rec = history.filter((e) => e.type === 'RECEIVED');
    expect(sent).toHaveLength(2);
    expect(rec).toHaveLength(2);
  });

  it('getHistory() returns newest-first (descending timestamp)', async () => {
    const h = await makeV2Harness();
    await h.module.addToHistory({
      type: 'SENT',
      amount: '10',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 1000,
      transferId: 'tx-1',
      tokenIds: [],
    });
    await h.module.addToHistory({
      type: 'RECEIVED',
      amount: '20',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 4000,
      transferId: 'tx-2',
      tokenIds: [],
    });
    await h.module.addToHistory({
      type: 'SENT',
      amount: '30',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 2500,
      transferId: 'tx-3',
      tokenIds: [],
    });
    const history = h.module.getHistory();
    expect(history.map((e) => e.timestamp)).toEqual([4000, 2500, 1000]);
  });

  it('getHistory() returns a defensive copy — mutating it does NOT corrupt the cache', async () => {
    const h = await makeV2Harness();
    await mint(h, 'UCT', 1_000n);
    await h.module.send({ recipient: '@bob', coinId: 'UCT', amount: '100' });

    const first = h.module.getHistory();
    expect(first).toHaveLength(1);
    first.length = 0;
    (first as TransactionHistoryEntry[]).push({
      id: 'fake',
      dedupKey: 'FAKE_x',
      type: 'SENT',
      amount: '0',
      coinId: 'x',
      symbol: 'x',
      timestamp: 0,
      tokenIds: [],
    });

    const second = h.module.getHistory();
    expect(second).toHaveLength(1);
    expect(second[0].id).not.toBe('fake');
  });

  it('addToHistory() records the entry with a synthesized id + dedupKey', async () => {
    const h = await makeV2Harness();
    await h.module.addToHistory({
      type: 'RECEIVED',
      amount: '99',
      coinId: 'UCT',
      symbol: 'UCT',
      timestamp: 5000,
      tokenIds: [],
    });
    const history = h.module.getHistory();
    expect(history).toHaveLength(1);
    const entry = history[0];
    expect(entry.id).toBeTruthy();
    expect(entry.dedupKey).toBeTruthy();
    expect(entry.amount).toBe('99');
    expect(entry.type).toBe('RECEIVED');
  });

  it('history persists through the token storage provider (save() called after each write)', async () => {
    const h = await makeV2Harness();
    await mint(h, 'UCT', 1_000n);
    const saveCountBefore = h.storage.saved.length;
    await h.module.send({ recipient: '@bob', coinId: 'UCT', amount: '100' });
    // At minimum: one save on mint, plus one save on token remove/split,
    // plus one save on history-record. We just assert at least one new
    // save happened.
    expect(h.storage.saved.length).toBeGreaterThan(saveCountBefore);
    // The most recent save carries the history entry.
    const last = h.storage.saved[h.storage.saved.length - 1];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(Array.isArray((last as any)._history)).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((last as any)._history.some((h: TransactionHistoryEntry) => h.type === 'SENT')).toBe(
      true,
    );
  });

  it('failed send does NOT record a history entry', async () => {
    const h = await makeV2Harness();
    // Insufficient balance → failed.
    const result = await h.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '1000',
    });
    expect(result.status).toBe('failed');
    expect(h.module.getHistory()).toHaveLength(0);
  });

  it('history survives a load/save round-trip via persistAll → loadFromStorageData', async () => {
    const h1 = await makeV2Harness();
    await mint(h1, 'UCT', 1_000n);
    await h1.module.send({
      recipient: '@bob',
      coinId: 'UCT',
      amount: '100',
      memo: 'roundtrip',
    });
    // Grab the last-saved storage payload.
    const saved = h1.storage.saved[h1.storage.saved.length - 1];

    // Boot a fresh harness preloaded with that data.
    const h2 = await makeV2Harness({ initialStorageData: saved });
    const history = h2.module.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('SENT');
    expect(history[0].memo).toBe('roundtrip');
    expect(history[0].amount).toBe('100');
  });
});
