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
} from '../../../../extensions/uxf/pipeline/finalization-queue';

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
  it('corrupt JSON treated as absent + alert + auto-delete', async () => {
    const storage = makeFakeStorage();
    const alerts: Array<{ key: string; entryId: string; rawSnippet: string }> = [];
    const q = new FinalizationQueue({
      storage,
      onCorruptSlot: ({ key, entryId, rawSnippet }) => {
        alerts.push({ key, entryId, rawSnippet });
      },
    });
    const corruptKey = keyFor(ADDR, 'corrupt');
    storage.map.set(corruptKey, '{not json');
    const got = await q.get(ADDR, 'corrupt');
    expect(got).toBeUndefined();
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.key).toBe(corruptKey);
    expect(alerts[0]!.entryId).toBe('corrupt');
    expect(alerts[0]!.rawSnippet).toBe('{not json');
    // Slot was auto-deleted so a subsequent add() can rewrite it.
    expect(storage.map.has(corruptKey)).toBe(false);
    const all = await q.list(ADDR);
    expect(all.length).toBe(0);
  });

  it('value missing required fields treated as absent + alert + delete', async () => {
    const storage = makeFakeStorage();
    let alertCalls = 0;
    const q = new FinalizationQueue({
      storage,
      onCorruptSlot: () => {
        alertCalls++;
      },
    });
    const malformedKey = keyFor(ADDR, 'malformed');
    storage.map.set(
      malformedKey,
      JSON.stringify({ entryId: 'x', tokenId: 'y' }),
    );
    const got = await q.get(ADDR, 'malformed');
    expect(got).toBeUndefined();
    expect(alertCalls).toBe(1);
    expect(storage.map.has(malformedKey)).toBe(false);
  });

  it('list() alerts and deletes corrupt slots inline', async () => {
    const storage = makeFakeStorage();
    const alerts: string[] = [];
    const q = new FinalizationQueue({
      storage,
      onCorruptSlot: ({ entryId }) => {
        alerts.push(entryId);
      },
    });
    const live = makeEntry({ entryId: 'live' });
    await q.add(ADDR, live);
    storage.map.set(keyFor(ADDR, 'broken-1'), 'not-json');
    storage.map.set(keyFor(ADDR, 'broken-2'), JSON.stringify({ ok: true }));
    const listed = await q.list(ADDR);
    expect(listed.map((e) => e.entryId)).toEqual(['live']);
    expect(alerts.sort()).toEqual(['broken-1', 'broken-2']);
    // Both corrupt slots auto-deleted.
    expect(storage.map.has(keyFor(ADDR, 'broken-1'))).toBe(false);
    expect(storage.map.has(keyFor(ADDR, 'broken-2'))).toBe(false);
  });

  it('gcTombstones alerts + deletes corrupt slots, returns deletion count', async () => {
    const storage = makeFakeStorage();
    let alertCount = 0;
    const q = new FinalizationQueue({
      storage,
      onCorruptSlot: () => {
        alertCount++;
      },
    });
    storage.map.set(keyFor(ADDR, 'broken-1'), '{');
    storage.map.set(keyFor(ADDR, 'broken-2'), '12345');
    const summary = await q.gcTombstones(ADDR);
    expect(summary.deleted).toBe(2);
    expect(alertCount).toBe(2);
    expect(storage.map.has(keyFor(ADDR, 'broken-1'))).toBe(false);
    expect(storage.map.has(keyFor(ADDR, 'broken-2'))).toBe(false);
  });

  it('corrupt-slot handler omitted → still auto-deletes (no throw)', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const k = keyFor(ADDR, 'broken');
    storage.map.set(k, 'garbage');
    const got = await q.get(ADDR, 'broken');
    expect(got).toBeUndefined();
    expect(storage.map.has(k)).toBe(false);
  });

  it('handler that throws does not break GC', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({
      storage,
      onCorruptSlot: () => {
        throw new Error('handler boom');
      },
    });
    const k = keyFor(ADDR, 'broken');
    storage.map.set(k, '{');
    const summary = await q.gcTombstones(ADDR);
    expect(summary.deleted).toBe(1);
    expect(storage.map.has(k)).toBe(false);
  });

  it('large corrupt blob is truncated to 512 chars in the alert', async () => {
    const storage = makeFakeStorage();
    let raw: string | undefined;
    const q = new FinalizationQueue({
      storage,
      onCorruptSlot: ({ rawSnippet }) => {
        raw = rawSnippet;
      },
    });
    const big = 'x'.repeat(1000);
    storage.map.set(keyFor(ADDR, 'big'), big);
    await q.get(ADDR, 'big');
    expect(raw).toBeDefined();
    expect(raw!.length).toBe(512 + 1); // 512 chars + ellipsis
    expect(raw!.endsWith('…')).toBe(true);
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

// =============================================================================
// Round 3 regression — pollStartedAt persistence + setPollStartedAt API (FIX 2)
// =============================================================================
//
// Pre-Round-3 the recipient's W26 cross-restart polling-deadline anchor
// was supposed to be the queue entry's `submittedAt`, with a CAS-update
// to wall-clock-now on first successful submit. But no code path
// actually performed that CAS-update — `submittedAt === createdAt` was
// the steady state and the deadline kept restarting on every cycle.
//
// Round 3 fix: dedicated `pollStartedAt` field on the queue entry,
// stamped exactly once via `setPollStartedAt`. Persisted across
// restarts; reads back the wall-clock first-poll time.

describe('FinalizationQueue — pollStartedAt (Round 3 regression)', () => {
  it('serialize + deserialize round-trips pollStartedAt when set', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry({ pollStartedAt: 1700000005000 });
    await q.add(ADDR, e);
    const got = await q.get(ADDR, e.entryId);
    expect(got).toBeDefined();
    expect(got?.pollStartedAt).toBe(1700000005000);
  });

  it('serialize + deserialize handles undefined pollStartedAt (legacy entries)', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    expect(e.pollStartedAt).toBeUndefined();
    await q.add(ADDR, e);
    const got = await q.get(ADDR, e.entryId);
    expect(got).toBeDefined();
    expect(got?.pollStartedAt).toBeUndefined();
  });

  it('setPollStartedAt stamps the field on first call and persists', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    await q.add(ADDR, e);

    const result = await q.setPollStartedAt(ADDR, e.entryId, 1700000010000);
    expect(result).toBe('set');

    const got = await q.get(ADDR, e.entryId);
    expect(got?.pollStartedAt).toBe(1700000010000);
  });

  it('setPollStartedAt is idempotent — second call returns "already-set" and does NOT overwrite', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    await q.add(ADDR, e);

    const r1 = await q.setPollStartedAt(ADDR, e.entryId, 1700000010000);
    expect(r1).toBe('set');

    const r2 = await q.setPollStartedAt(ADDR, e.entryId, 1700000020000);
    expect(r2).toBe('already-set');

    const got = await q.get(ADDR, e.entryId);
    expect(got?.pollStartedAt).toBe(1700000010000); // first stamp wins
  });

  it('setPollStartedAt on a tombstoned entry returns "absent"', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    await q.add(ADDR, e);
    await q.remove(ADDR, e.entryId);

    const result = await q.setPollStartedAt(ADDR, e.entryId, 1700000010000);
    expect(result).toBe('absent');
  });

  it('setPollStartedAt on a never-added entry returns "absent"', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const result = await q.setPollStartedAt(ADDR, 'nonexistent-entry-id', 1700000010000);
    expect(result).toBe('absent');
  });

  it('setPollStartedAt rejects non-finite when values', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    await q.add(ADDR, e);

    await expect(q.setPollStartedAt(ADDR, e.entryId, NaN)).rejects.toThrow();
    await expect(q.setPollStartedAt(ADDR, e.entryId, Infinity)).rejects.toThrow();
  });
});

// =============================================================================
// Round 5 FIX 2 — setPollStartedAt clock-skew bounds enforcement
// =============================================================================
//
// Pre-Round-5 setPollStartedAt accepted any finite number for `when`,
// including negative values, zero, MIN_VALUE, MAX_SAFE_INTEGER, and
// timestamps far in the future. Hostile or buggy callers could push
// the §5.5 step 6 "2 × POLLING_WINDOW_MS hard safety net" anchor
// arbitrarily, defeating the deadline.
//
// Fix: bound `when` to `[entry.createdAt - CLOCK_SKEW_TOLERANCE_MS,
// now + CLOCK_SKEW_TOLERANCE_MS]`, fail loudly with VALIDATION_ERROR
// on out-of-range values.

describe('FinalizationQueue — Round 5 FIX 2: setPollStartedAt bounds', () => {
  // Use a deterministic clock so the upper-bound `now + tolerance` is
  // predictable.
  const FAKE_NOW = 1700000300000; // 5 minutes after createdAt
  const TOLERANCE = 5 * 60 * 1000;

  it('rejects when = 0', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry(); // createdAt = 1700000000000
    await q.add(ADDR, e);
    await expect(q.setPollStartedAt(ADDR, e.entryId, 0)).rejects.toThrow();
  });

  it('rejects when = -1', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry();
    await q.add(ADDR, e);
    await expect(q.setPollStartedAt(ADDR, e.entryId, -1)).rejects.toThrow();
  });

  it('rejects when = Number.MAX_VALUE (far future)', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry();
    await q.add(ADDR, e);
    await expect(
      q.setPollStartedAt(ADDR, e.entryId, Number.MAX_VALUE),
    ).rejects.toThrow();
  });

  it('rejects when = Number.MAX_SAFE_INTEGER', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry();
    await q.add(ADDR, e);
    await expect(
      q.setPollStartedAt(ADDR, e.entryId, Number.MAX_SAFE_INTEGER),
    ).rejects.toThrow();
  });

  it('rejects when = now + tolerance + 1ms (just over upper bound)', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry();
    await q.add(ADDR, e);
    await expect(
      q.setPollStartedAt(ADDR, e.entryId, FAKE_NOW + TOLERANCE + 1),
    ).rejects.toThrow();
  });

  it('rejects when = createdAt - tolerance - 1ms (just under lower bound)', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry();
    await q.add(ADDR, e);
    await expect(
      q.setPollStartedAt(ADDR, e.entryId, e.createdAt - TOLERANCE - 1),
    ).rejects.toThrow();
  });

  it('accepts createdAt + 1ms (legitimate first-poll-after-create)', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry();
    await q.add(ADDR, e);
    const result = await q.setPollStartedAt(ADDR, e.entryId, e.createdAt + 1);
    expect(result).toBe('set');
    const got = await q.get(ADDR, e.entryId);
    expect(got?.pollStartedAt).toBe(e.createdAt + 1);
  });

  it('accepts when = now (poll started exactly at the wall-clock instant)', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry();
    await q.add(ADDR, e);
    const result = await q.setPollStartedAt(ADDR, e.entryId, FAKE_NOW);
    expect(result).toBe('set');
  });

  it('accepts when at exact lower bound (createdAt - tolerance)', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry();
    await q.add(ADDR, e);
    const result = await q.setPollStartedAt(
      ADDR,
      e.entryId,
      e.createdAt - TOLERANCE,
    );
    expect(result).toBe('set');
  });

  it('accepts when at exact upper bound (now + tolerance)', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage, now: () => FAKE_NOW });
    const e = makeEntry();
    await q.add(ADDR, e);
    const result = await q.setPollStartedAt(
      ADDR,
      e.entryId,
      FAKE_NOW + TOLERANCE,
    );
    expect(result).toBe('set');
  });

  it('deserializeEntry drops persisted pollStartedAt below lower bound (corrupt-write recovery)', async () => {
    // Simulate a pre-fix corruption: an entry persisted with a
    // far-out-of-bounds pollStartedAt (e.g., -1). The read side must
    // silently drop the field so the worker stamps a fresh one on
    // next poll.
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({ storage });
    const e = makeEntry();
    await q.add(ADDR, e);
    // Tamper the persisted JSON to inject a corrupt pollStartedAt.
    const key = `${ADDR}.finalizationQueue.${e.entryId}`;
    const raw = storage.map.get(key);
    expect(raw).toBeDefined();
    const obj = JSON.parse(raw as string) as Record<string, unknown>;
    obj.pollStartedAt = -1;
    storage.map.set(key, JSON.stringify(obj));

    const got = await q.get(ADDR, e.entryId);
    expect(got).toBeDefined();
    // The corrupt pollStartedAt is dropped on read.
    expect(got?.pollStartedAt).toBeUndefined();
  });
});

// =============================================================================
// Round 5 FIX 5 — CRDT race documentation (last-writer-wins)
// =============================================================================
//
// The read-modify-write in setPollStartedAt is NOT atomic at the
// storage layer. Two concurrent calls can both observe undefined and
// both write distinct values; last-writer-wins. The persisted result
// is one of the two values (not a torn write). This test documents
// the semantic.

describe('FinalizationQueue — Round 5 FIX 5: setPollStartedAt CRDT LWW semantics', () => {
  it('two concurrent setPollStartedAt calls converge on a single persisted value', async () => {
    const storage = makeFakeStorage();
    const q = new FinalizationQueue({
      storage,
      now: () => 1700000300000,
    });
    const e = makeEntry();
    await q.add(ADDR, e);

    // Two concurrent stamps. Both observe undefined; both write.
    const t1 = e.createdAt + 100;
    const t2 = e.createdAt + 200;
    const [r1, r2] = await Promise.all([
      q.setPollStartedAt(ADDR, e.entryId, t1),
      q.setPollStartedAt(ADDR, e.entryId, t2),
    ]);

    // At least one returns 'set' (the actual race winner is
    // implementation-defined under last-writer-wins semantics).
    const setCount = [r1, r2].filter((r) => r === 'set').length;
    expect(setCount).toBeGreaterThanOrEqual(1);

    // The persisted value MUST be one of the two candidates — never
    // a torn or arbitrary write.
    const got = await q.get(ADDR, e.entryId);
    expect(got).toBeDefined();
    expect(got?.pollStartedAt === t1 || got?.pollStartedAt === t2).toBe(true);
  });
});
