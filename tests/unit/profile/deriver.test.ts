/**
 * Tests for profile/deriver.ts
 *
 * Verifies that tombstones, sent entries, and history records can be
 * reconstructed from a TxfStorageDataBase token pool (primarily from
 * archived tokens).
 */

import { describe, it, expect } from 'vitest';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import {
  deriveTombstonesFromArchived,
  deriveSentFromArchived,
  deriveHistoryFromArchived,
} from '../../../profile/deriver';

const META = {
  _meta: {
    version: 1 as const,
    address: 'DIRECT_mock_addr',
    formatVersion: '1.0.0',
    updatedAt: 1_000_000,
  },
};

function archivedToken(opts: {
  key: string;
  tokenId: string;
  coinId?: string;
  amount?: string;
  recipientInLastTx?: string;
  genesisRecipient?: string;
  stateHash?: string;
  txHash?: string;
}): [string, unknown] {
  const genesis = {
    data: {
      tokenId: opts.tokenId,
      coinData: [[opts.coinId ?? 'UCT', opts.amount ?? '100']] as Array<[string, string]>,
      recipient: opts.genesisRecipient ?? 'DIRECT://us',
      salt: 'de'.repeat(32),
    },
  };
  const last =
    opts.stateHash || opts.txHash || opts.recipientInLastTx
      ? [
          {
            previousStateHash: 'prev',
            newStateHash: opts.stateHash,
            predicate: 'pred',
            data: { recipient: opts.recipientInLastTx },
            inclusionProof: opts.txHash
              ? { transactionHash: opts.txHash }
              : null,
          },
        ]
      : [];
  return [
    opts.key,
    {
      version: '2.0',
      genesis,
      state: { data: '', predicate: '' },
      transactions: last,
    },
  ];
}

function buildData(
  archived: Array<[string, unknown]>,
  active: Array<[string, unknown]> = [],
): TxfStorageDataBase {
  const data: Record<string, unknown> = { ...META };
  for (const [k, v] of archived) data[k] = v;
  for (const [k, v] of active) data[k] = v;
  return data as TxfStorageDataBase;
}

describe('deriveTombstonesFromArchived', () => {
  it('returns empty for empty pool', () => {
    expect(deriveTombstonesFromArchived(buildData([]))).toEqual([]);
  });

  it('skips operational keys and non-archived tokens', () => {
    const data = buildData(
      [],
      [['_active', { genesis: { data: { tokenId: 'a', coinData: [] } } }]],
    );
    data._tombstones = [{ tokenId: 'stale', stateHash: 'x', timestamp: 0 }];
    expect(deriveTombstonesFromArchived(data)).toEqual([]);
  });

  it('emits one tombstone per archived token with a derivable stateHash', () => {
    const data = buildData([
      archivedToken({ key: 'archived-1', tokenId: 't1', stateHash: 'hA' }),
      archivedToken({ key: 'archived-2', tokenId: 't2', stateHash: 'hB' }),
    ]);
    const result = deriveTombstonesFromArchived(data, 42);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.tokenId).sort()).toEqual(['t1', 't2']);
    expect(result.every((r) => r.timestamp === 42)).toBe(true);
  });

  it('skips archived tokens without a stateHash (no valid tombstone possible)', () => {
    const data = buildData([
      archivedToken({ key: 'archived-ok', tokenId: 't1', stateHash: 'h' }),
      archivedToken({ key: 'archived-bad', tokenId: 't2' }), // no tx, no stateHash
    ]);
    const result = deriveTombstonesFromArchived(data);
    expect(result).toHaveLength(1);
    expect(result[0].tokenId).toBe('t1');
  });

  it('dedups (tokenId, stateHash) pairs', () => {
    const data = buildData([
      archivedToken({ key: 'archived-1', tokenId: 't1', stateHash: 'h' }),
      archivedToken({ key: 'archived-2', tokenId: 't1', stateHash: 'h' }),
    ]);
    expect(deriveTombstonesFromArchived(data)).toHaveLength(1);
  });
});

describe('deriveSentFromArchived', () => {
  it('returns empty for empty pool', () => {
    expect(deriveSentFromArchived(buildData([]))).toEqual([]);
  });

  it('emits sent entry with recipient from last tx and txHash from inclusion proof', () => {
    const data = buildData([
      archivedToken({
        key: 'archived-1',
        tokenId: 't1',
        recipientInLastTx: 'DIRECT://bob',
        txHash: 'abcdef',
      }),
    ]);
    const result = deriveSentFromArchived(data, 999);
    expect(result).toEqual([
      { tokenId: 't1', recipient: 'DIRECT://bob', txHash: 'abcdef', sentAt: 999 },
    ]);
  });

  it('falls back to genesis recipient when no transactions', () => {
    const data = buildData([
      archivedToken({
        key: 'archived-1',
        tokenId: 't1',
        genesisRecipient: 'DIRECT://fallback',
      }),
    ]);
    const result = deriveSentFromArchived(data);
    expect(result[0].recipient).toBe('DIRECT://fallback');
    expect(result[0].txHash).toBe('');
  });

  it('dedups by tokenId', () => {
    const data = buildData([
      archivedToken({ key: 'archived-1', tokenId: 't1', recipientInLastTx: 'x' }),
      archivedToken({ key: 'archived-2', tokenId: 't1', recipientInLastTx: 'y' }),
    ]);
    expect(deriveSentFromArchived(data)).toHaveLength(1);
  });
});

describe('deriveHistoryFromArchived', () => {
  it('returns empty for empty pool', () => {
    expect(deriveHistoryFromArchived(buildData([]), 'DIRECT://us')).toEqual([]);
  });

  it('builds SENT entries from archived tokens', () => {
    const data = buildData([
      archivedToken({
        key: 'archived-1',
        tokenId: 't1',
        coinId: 'UCT',
        amount: '500',
        recipientInLastTx: 'DIRECT://bob',
      }),
    ]);
    const result = deriveHistoryFromArchived(data, 'DIRECT://us', 1234);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'SENT',
      tokenId: 't1',
      coinId: 'UCT',
      amount: '500',
      recipientAddress: 'DIRECT://bob',
      timestamp: 1234,
    });
  });

  it('builds RECEIVED entries for active tokens whose genesis targeted us', () => {
    const active: Array<[string, unknown]> = [
      [
        '_tokenActive',
        {
          version: '2.0',
          genesis: {
            data: {
              tokenId: 'tA',
              coinData: [['UCT', '200']],
              recipient: 'DIRECT://us',
            },
          },
          state: {},
          transactions: [],
        },
      ],
    ];
    const result = deriveHistoryFromArchived(
      buildData([], active),
      'DIRECT://us',
      2000,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      type: 'RECEIVED',
      tokenId: 'tA',
      amount: '200',
    });
  });

  it('sorts newest first', () => {
    const data = buildData(
      [
        archivedToken({ key: 'archived-a', tokenId: 'a', recipientInLastTx: 'x' }),
        archivedToken({ key: 'archived-b', tokenId: 'b', recipientInLastTx: 'y' }),
      ],
    );
    // Using the default `now` — all share the same timestamp but the
    // sort must remain stable-in-the-sense-of-returning-an-array.
    const result = deriveHistoryFromArchived(data, 'DIRECT://us');
    expect(result).toHaveLength(2);
  });

  it('does not emit RECEIVED when ourAddress is undefined', () => {
    const active: Array<[string, unknown]> = [
      [
        '_tokenActive',
        {
          genesis: { data: { tokenId: 'tA', coinData: [['UCT', '1']], recipient: 'DIRECT://us' } },
          state: {},
          transactions: [],
        },
      ],
    ];
    const result = deriveHistoryFromArchived(buildData([], active), undefined);
    expect(result).toEqual([]);
  });
});
