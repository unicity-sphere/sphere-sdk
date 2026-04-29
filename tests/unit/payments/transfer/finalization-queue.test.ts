/**
 * UXF Transfer T.5.C — finalization-queue (Wave G.7 per-entry-key).
 *
 * Verifies the typed wrapper's CRUD round-trips, tombstone semantics,
 * and `lookupByTokenId` filter behavior.
 *
 * Spec refs: §5.5 (finalization queue), §5.6 (tombstone retention),
 * PA §10.12 (per-entry-key layout).
 */

import { describe, expect, it } from 'vitest';

import {
  FinalizationQueue,
  TOMBSTONE_RETENTION_MS,
  entryIdFor,
  keyFor,
  parseQueueValue,
  prefixFor,
  type FinalizationQueueEntry,
  type FinalizationQueueStorage,
} from '../../../../modules/payments/transfer/finalization-queue';

const ADDR = 'DIRECT://addr-A';
const TOKEN_A = 'token-aaaa';
const TOKEN_B = 'token-bbbb';

function makeFakeStorage(): FinalizationQueueStorage & {
  readonly map: Map<string, string>;
} {
  const map = new Map<string, string>();
  return {
    map,
    async readKey(key) {
      return map.has(key) ? (map.get(key) ?? null) : null;
    },
    async writeKey(key, value) {
      map.set(key, value);
    },
    async listByPrefix(prefix) {
      const out = new Map<string, string>();
      for (const [k] of map) {
        if (k.startsWith(prefix)) out.set(k, k.slice(prefix.length));
      }
      return out;
    },
    async deleteKey(key) {
      map.delete(key);
    },
  };
}

function makeEntry(
  overrides: Partial<FinalizationQueueEntry> = {},
): FinalizationQueueEntry {
  return {
    entryId: entryIdFor(TOKEN_A, 0),
    tokenId: TOKEN_A,
    bundleCid: 'bafy-bundle',
    txIndex: 0,
    commitmentRequestId: 'req-1',
    transactionHash: `0000${'aa'.repeat(32)}`,
    authenticator: 'cc'.repeat(32),
    submittedAt: 1700000000000,
    createdAt: 1700000000000,
    submitRetryCount: 0,
    proofErrorCount: 0,
    status: 'pending',
    source: 'received',
    ...overrides,
  };
}

describe('FinalizationQueue — basic CRUD', () => {
  it('add then get round-trips an entry', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    await q.add(ADDR, e);
    const got = await q.get(ADDR, e.entryId);
    expect(got).toBeDefined();
    expect(got!.entryId).toBe(e.entryId);
    expect(got!.tokenId).toBe(e.tokenId);
    expect(got!.commitmentRequestId).toBe(e.commitmentRequestId);
    expect(got!.transactionHash).toBe(e.transactionHash);
  });

  it('add is idempotent — overwriting same entry converges', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    await q.add(ADDR, e);
    await q.add(ADDR, e);
    const got = await q.get(ADDR, e.entryId);
    expect(got).toBeDefined();
  });

  it('remove writes tombstone — get returns undefined', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    await q.add(ADDR, e);
    await q.remove(ADDR, e.entryId);
    const got = await q.get(ADDR, e.entryId);
    expect(got).toBeUndefined();
  });

  it('hasEntry mirrors get presence', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    expect(await q.hasEntry(ADDR, e.entryId)).toBe(false);
    await q.add(ADDR, e);
    expect(await q.hasEntry(ADDR, e.entryId)).toBe(true);
    await q.remove(ADDR, e.entryId);
    expect(await q.hasEntry(ADDR, e.entryId)).toBe(false);
  });

  it('list returns every live entry — tombstones filtered', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const a = makeEntry({ entryId: entryIdFor(TOKEN_A, 0) });
    const b = makeEntry({ entryId: entryIdFor(TOKEN_A, 1), txIndex: 1 });
    await q.add(ADDR, a);
    await q.add(ADDR, b);
    let listed = await q.list(ADDR);
    expect(listed.map((e) => e.entryId).sort()).toEqual(
      [a.entryId, b.entryId].sort(),
    );
    await q.remove(ADDR, a.entryId);
    listed = await q.list(ADDR);
    expect(listed.map((e) => e.entryId)).toEqual([b.entryId]);
  });

  it('lookupByTokenId filters to a single tokenId', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const a0 = makeEntry({
      tokenId: TOKEN_A,
      entryId: entryIdFor(TOKEN_A, 0),
    });
    const a1 = makeEntry({
      tokenId: TOKEN_A,
      entryId: entryIdFor(TOKEN_A, 1),
      txIndex: 1,
    });
    const b0 = makeEntry({
      tokenId: TOKEN_B,
      entryId: entryIdFor(TOKEN_B, 0),
    });
    await q.add(ADDR, a0);
    await q.add(ADDR, a1);
    await q.add(ADDR, b0);
    const onlyA = await q.lookupByTokenId(ADDR, TOKEN_A);
    expect(onlyA.map((e) => e.entryId).sort()).toEqual(
      [a0.entryId, a1.entryId].sort(),
    );
    const onlyB = await q.lookupByTokenId(ADDR, TOKEN_B);
    expect(onlyB.map((e) => e.entryId)).toEqual([b0.entryId]);
  });

  it('preserves signedTransferTxBytes through round-trip', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const e = makeEntry({ signedTransferTxBytes: bytes });
    await q.add(ADDR, e);
    const got = await q.get(ADDR, e.entryId);
    expect(got).toBeDefined();
    expect(got!.signedTransferTxBytes).toBeDefined();
    expect(Array.from(got!.signedTransferTxBytes!)).toEqual([
      0xde,
      0xad,
      0xbe,
      0xef,
    ]);
  });
});

describe('FinalizationQueue — tombstone retention + GC', () => {
  it('gcTombstones leaves fresh tombstones; deletes old ones', async () => {
    const storage = makeFakeStorage();
    let now = 1_000_000_000_000;
    const q = new FinalizationQueue({
      storage,
      now: () => now,
      tombstoneRetentionMs: TOMBSTONE_RETENTION_MS,
    });
    const e = makeEntry();
    await q.add(ADDR, e);
    await q.remove(ADDR, e.entryId);
    // Fresh tombstone — not yet retention-elapsed.
    let summary = await q.gcTombstones(ADDR);
    expect(summary.deleted).toBe(0);
    expect(summary.scanned).toBeGreaterThan(0);
    // Advance past retention.
    now = now + TOMBSTONE_RETENTION_MS + 1;
    summary = await q.gcTombstones(ADDR);
    expect(summary.deleted).toBe(1);
    // After GC, the storage map should not contain the key.
    expect(storage.map.has(keyFor(ADDR, e.entryId))).toBe(false);
  });

  it('gcTombstones is best-effort — delete failure does not abort', async () => {
    const storage = makeFakeStorage();
    const original = storage.deleteKey.bind(storage);
    let throwOnce = true;
    storage.deleteKey = async (key) => {
      if (throwOnce) {
        throwOnce = false;
        throw new Error('transient backend error');
      }
      return original(key);
    };
    let now = 1_000_000_000_000;
    const q = new FinalizationQueue({
      storage,
      now: () => now,
      tombstoneRetentionMs: 0,
    });
    const a = makeEntry({ entryId: 'a' });
    const b = makeEntry({ entryId: 'b' });
    await q.add(ADDR, a);
    await q.add(ADDR, b);
    await q.remove(ADDR, a.entryId);
    await q.remove(ADDR, b.entryId);
    now = now + 1;
    const summary = await q.gcTombstones(ADDR);
    // First delete throws (swallowed); second succeeds.
    expect(summary.deleted).toBe(1);
  });
});

describe('FinalizationQueue — validation', () => {
  it('add rejects empty addr', async () => {
    const q = new FinalizationQueue({ storage: makeFakeStorage() });
    await expect(q.add('', makeEntry())).rejects.toThrow();
  });

  it('add rejects entry with empty tokenId', async () => {
    const q = new FinalizationQueue({ storage: makeFakeStorage() });
    await expect(
      q.add(ADDR, { ...makeEntry(), tokenId: '' }),
    ).rejects.toThrow();
  });

  it('add rejects entry with negative txIndex', async () => {
    const q = new FinalizationQueue({ storage: makeFakeStorage() });
    await expect(
      q.add(ADDR, { ...makeEntry(), txIndex: -1 }),
    ).rejects.toThrow();
  });

  it('lookupByTokenId rejects empty tokenId', async () => {
    const q = new FinalizationQueue({ storage: makeFakeStorage() });
    await expect(q.lookupByTokenId(ADDR, '')).rejects.toThrow();
  });

  it('entryIdFor rejects negative txIndex', () => {
    expect(() => entryIdFor(TOKEN_A, -1)).toThrow();
    expect(() => entryIdFor(TOKEN_A, 1.5)).toThrow();
  });

  it('constructor rejects negative tombstoneRetentionMs', () => {
    expect(
      () =>
        new FinalizationQueue({
          storage: makeFakeStorage(),
          tombstoneRetentionMs: -1,
        }),
    ).toThrow();
  });
});

describe('FinalizationQueue — corrupt slot handling', () => {
  it('corrupt JSON treated as absent', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    storage.map.set(keyFor(ADDR, 'corrupt'), '{not json');
    const got = await q.get(ADDR, 'corrupt');
    expect(got).toBeUndefined();
    const all = await q.list(ADDR);
    expect(all.length).toBe(0);
  });

  it('value missing required fields treated as absent', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    storage.map.set(
      keyFor(ADDR, 'malformed'),
      JSON.stringify({ entryId: 'x', tokenId: 'y' }),
    );
    const got = await q.get(ADDR, 'malformed');
    expect(got).toBeUndefined();
  });

  it('parseQueueValue distinguishes absent / tombstone / entry', () => {
    expect(parseQueueValue('not json').kind).toBe('absent');
    expect(parseQueueValue('null').kind).toBe('absent');
    expect(parseQueueValue('"string"').kind).toBe('absent');
    expect(
      parseQueueValue(JSON.stringify({ tombstoned: true, deletedAt: 1 }))
        .kind,
    ).toBe('tombstone');
    const entry = makeEntry();
    const serialized = JSON.stringify({
      entryId: entry.entryId,
      tokenId: entry.tokenId,
      bundleCid: entry.bundleCid,
      txIndex: entry.txIndex,
      commitmentRequestId: entry.commitmentRequestId,
      transactionHash: entry.transactionHash,
      authenticator: entry.authenticator,
      submittedAt: entry.submittedAt,
      createdAt: entry.createdAt,
      submitRetryCount: entry.submitRetryCount,
      proofErrorCount: entry.proofErrorCount,
      status: entry.status,
      source: entry.source,
    });
    expect(parseQueueValue(serialized).kind).toBe('entry');
  });
});

describe('FinalizationQueue — keyFor / prefixFor / entryIdFor', () => {
  it('keyFor composes ${addr}.finalizationQueue.${entryId}', () => {
    expect(keyFor(ADDR, 'x')).toBe(`${ADDR}.finalizationQueue.x`);
  });

  it('prefixFor exposes the listing prefix', () => {
    expect(prefixFor(ADDR)).toBe(`${ADDR}.finalizationQueue.`);
  });

  it('entryIdFor composes ${tokenId}:${txIndex}', () => {
    expect(entryIdFor(TOKEN_A, 0)).toBe(`${TOKEN_A}:0`);
    expect(entryIdFor(TOKEN_A, 7)).toBe(`${TOKEN_A}:7`);
  });
});
