/**
 * Tests for serialization/txf-serializer.ts
 *
 * Scope after the v1-TXF removal: the storage DOCUMENT only (`_meta`,
 * `_nametag(s)`, `_tombstones`, `_history`, per-token slots). The v1 TXF token
 * codec is gone, so the tests that pinned it were deleted; what remains here
 * pins the document shape plus the loud refusal of legacy v1 token records.
 * The v2 token blob round-trip lives in `txf-serializer.v2.test.ts`.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  buildTxfStorageData,
  parseTxfStorageData,
} from '../../../serialization/txf-serializer';
import { logger } from '../../../core/logger';
import type { Token } from '../../../types';
import type { TxfToken } from '../../../types/txf';

// =============================================================================
// Test Fixtures
// =============================================================================

const META = { version: 1, address: '02test', ipnsName: 'k51test' };

/**
 * A v2 storage entry — the UI token record with an opaque hex blob in
 * `sdkData`. The document layer never decodes the blob, so a short hex string
 * is a faithful stand-in here (real engine blobs are exercised in the v2 test).
 */
function v2Token(overrides: Partial<Token> = {}): Token {
  return {
    id: 'v2_' + 'ab'.repeat(32),
    coinId: 'cd'.repeat(32),
    symbol: 'TST',
    name: 'Test',
    decimals: 8,
    amount: '1000',
    status: 'confirmed',
    createdAt: 1,
    updatedAt: 1,
    sdkData: 'deadbeefcafe0123',
    ...overrides,
  };
}

/** A pre-v2 stored TXF token record — recognised only so it can be refused. */
function legacyV1TxfEntry(): TxfToken {
  return {
    version: '2.0',
    genesis: {
      data: {
        tokenId: 'ef'.repeat(32),
        tokenType: 'fungible_type_hash',
        salt: 'random_salt_hex',
        coinData: [['TOKEN_HEX', '1000']],
        tokenData: '',
        recipient: 'DIRECT://abc',
        recipientDataHash: null,
        reason: null,
      },
      inclusionProof: {
        authenticator: {
          algorithm: 'secp256k1',
          publicKey: 'pubkey_hex',
          signature: 'sig_hex',
          stateHash: 'state_hash_hex',
        },
        merkleTreePath: { root: 'root_hash_hex', steps: [] },
        transactionHash: 'tx_hash_hex',
        unicityCertificate: 'cert_hex',
      },
    },
    transactions: [],
    nametags: [],
    state: { data: 'state_data_hex', predicate: 'predicate_hex' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// buildTxfStorageData
// =============================================================================

describe('buildTxfStorageData()', () => {
  it('should build storage data with meta', async () => {
    const result = await buildTxfStorageData([v2Token()], META);

    expect(result._meta).toBeDefined();
    expect(result._meta.version).toBe(1);
    expect(result._meta.formatVersion).toBe('2.0');
  });

  it('should store a v2 token under its _<tokenId> key', async () => {
    const token = v2Token();
    const result = await buildTxfStorageData([token], META);

    const tokenKeys = Object.keys(result).filter((k) => k.startsWith('_') && k !== '_meta');
    expect(tokenKeys).toEqual(['_' + 'ab'.repeat(32)]);
  });

  it('should NOT include nametag in TXF (saved separately as nametag-{name}.json)', async () => {
    const nametag = {
      name: 'alice',
      token: 'aabb',
      timestamp: Date.now(),
      format: 'v2-cbor',
      version: '2.0',
    };

    const result = await buildTxfStorageData([], META, { nametags: [nametag] });

    // Nametag is no longer saved as the singular _nametag slot
    expect(result._nametag).toBeUndefined();
    expect(result._nametags).toEqual([nametag]);
  });

  it('should include tombstones if provided', async () => {
    const tombstones = [{ tokenId: 'abc', stateHash: 'hash', timestamp: Date.now() }];

    const result = await buildTxfStorageData([], META, { tombstones });

    expect(result._tombstones).toEqual(tombstones);
  });

  it('should not include empty arrays', async () => {
    const result = await buildTxfStorageData([], META, { tombstones: [] });

    expect(result._tombstones).toBeUndefined();
  });

  it('should include historyEntries as _history if provided', async () => {
    const historyEntries = [
      {
        dedupKey: 'RECEIVED_token1',
        id: 'uuid-1',
        type: 'RECEIVED' as const,
        amount: '1000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 1000,
      },
    ];

    const result = await buildTxfStorageData([], META, { historyEntries });

    expect((result as Record<string, unknown>)._history).toEqual(historyEntries);
  });

  it('should not include _history if historyEntries is empty', async () => {
    const result = await buildTxfStorageData([], META, { historyEntries: [] });

    expect((result as Record<string, unknown>)._history).toBeUndefined();
  });

  it('refuses a legacy v1 TXF token loudly instead of persisting it', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const v1 = v2Token({ id: 'legacy1', sdkData: JSON.stringify(legacyV1TxfEntry()) });

    const result = await buildTxfStorageData([v1], META);

    expect(Object.keys(result).filter((k) => k.startsWith('_') && k !== '_meta')).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });
});

// =============================================================================
// parseTxfStorageData
// =============================================================================

describe('parseTxfStorageData()', () => {
  it('should parse valid storage data', async () => {
    const token = v2Token();
    const storageData = await buildTxfStorageData([token], META);

    const parsed = parseTxfStorageData(storageData);

    expect(parsed.tokens.length).toBe(1);
    expect(parsed.tokens[0].sdkData).toBe(token.sdkData);
    expect(parsed.meta).toBeDefined();
    expect(parsed.validationErrors.length).toBe(0);
  });

  it('should extract meta and nametag (backwards compatibility)', async () => {
    const nametag = {
      name: 'bob',
      token: 'aabb',
      timestamp: Date.now(),
      format: 'v2-cbor',
      version: '2.0',
    };
    const storageData = await buildTxfStorageData([], { ...META, version: 2 });
    // Simulate old storage format where the singular _nametag was included
    (storageData as Record<string, unknown>)._nametag = nametag;

    const parsed = parseTxfStorageData(storageData);

    expect(parsed.meta?.version).toBe(2);
    expect(parsed.nametags[0]?.name).toBe('bob');
  });

  it('should extract tombstones', async () => {
    const tombstones = [{ tokenId: 'dead', stateHash: 'hash1', timestamp: 12345 }];
    const storageData = await buildTxfStorageData([], META, { tombstones });

    const parsed = parseTxfStorageData(storageData);

    expect(parsed.tombstones.length).toBe(1);
    expect(parsed.tombstones[0].tokenId).toBe('dead');
  });

  it('should handle null input', () => {
    const parsed = parseTxfStorageData(null);

    expect(parsed.tokens.length).toBe(0);
    expect(parsed.validationErrors.length).toBeGreaterThan(0);
  });

  it('should handle non-object input', () => {
    const parsed = parseTxfStorageData('not an object');

    expect(parsed.validationErrors.length).toBeGreaterThan(0);
  });

  it('should extract history entries from _history', async () => {
    const historyEntries = [
      {
        dedupKey: 'RECEIVED_token1',
        id: 'uuid-1',
        type: 'RECEIVED' as const,
        amount: '1000',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 1000,
      },
      {
        dedupKey: 'SENT_transfer_tx1',
        id: 'uuid-2',
        type: 'SENT' as const,
        amount: '500',
        coinId: 'UCT',
        symbol: 'UCT',
        timestamp: 2000,
        transferId: 'tx1',
        recipientNametag: 'bob',
      },
    ];
    const storageData = await buildTxfStorageData([], META, { historyEntries });

    const parsed = parseTxfStorageData(storageData);

    expect(parsed.historyEntries).toHaveLength(2);
    expect(parsed.historyEntries[0].dedupKey).toBe('RECEIVED_token1');
    expect(parsed.historyEntries[1].dedupKey).toBe('SENT_transfer_tx1');
    expect(parsed.historyEntries[1].recipientNametag).toBe('bob');
  });

  it('should skip malformed history entries', () => {
    const storageData = {
      _meta: { version: 1, address: '02test', ipnsName: '', formatVersion: '2.0' },
      _history: [
        { dedupKey: 'valid', type: 'RECEIVED', amount: '100', coinId: 'UCT', symbol: 'UCT', timestamp: 1000, id: 'x' },
        { notADedupKey: 'bad' },        // missing dedupKey
        { dedupKey: 123, type: 'SENT' }, // dedupKey is not string
        null,                            // null entry
        'not-an-object',                 // string entry
      ],
    };

    const parsed = parseTxfStorageData(storageData);

    expect(parsed.historyEntries).toHaveLength(1);
    expect(parsed.historyEntries[0].dedupKey).toBe('valid');
  });

  it('should handle missing _history gracefully', () => {
    const parsed = parseTxfStorageData({
      _meta: { version: 1, address: 'test', ipnsName: '', formatVersion: '2.0' },
    });

    expect(parsed.historyEntries).toEqual([]);
  });
});

// =============================================================================
// Loud refusal of removed v1 shapes
// =============================================================================

describe('parseTxfStorageData() — legacy v1 records are refused, never coerced', () => {
  it('reports a stored v1 TXF token as a validation error and drops it', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const tokenId = 'ef'.repeat(32);

    const parsed = parseTxfStorageData({
      _meta: { version: 1, address: '02test', ipnsName: '', formatVersion: '2.0' },
      [`_${tokenId}`]: legacyV1TxfEntry(),
    });

    expect(parsed.tokens).toHaveLength(0);
    expect(parsed.validationErrors.join(' ')).toContain(tokenId);
    expect(parsed.validationErrors.join(' ')).toContain('v1 TXF');
    expect(warn).toHaveBeenCalled();
  });

  it('reports a legacy per-file `token-` record as a validation error and drops it', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const parsed = parseTxfStorageData({
      _meta: { version: 1, address: '02test', ipnsName: '', formatVersion: '2.0' },
      'token-abc': { token: legacyV1TxfEntry() },
    });

    expect(parsed.tokens).toHaveLength(0);
    expect(parsed.validationErrors.join(' ')).toContain('token-abc');
    expect(warn).toHaveBeenCalled();
  });

  it('reports an unrecognized token slot instead of silently accepting it', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const parsed = parseTxfStorageData({
      _meta: { version: 1, address: '02test', ipnsName: '', formatVersion: '2.0' },
      _somethingElse: { not: 'a token' },
    });

    expect(parsed.tokens).toHaveLength(0);
    expect(parsed.validationErrors).toHaveLength(1);
    expect(warn).toHaveBeenCalled();
  });
});
