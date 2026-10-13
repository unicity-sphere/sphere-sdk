/**
 * §5.1 restore, unit level (#835): the reseed re-PUTs only an intent whose PUT
 * was acked, judged on the entry as it is NOW (a fence may tombstone one while
 * the reseed runs), and announces itself before it reads the backstop so a
 * concurrent send knows its PUT may be repeated behind its back.
 */
import { describe, expect, it } from 'vitest';

import { createMachineStores } from '../../../modules/payments-v2/machine/journal';
import { reseedAndReset, type RestoreDeps } from '../../../modules/payments-v2/restore';
import { STORE_KEYS, type IntentBackstopEntry } from '../../../modules/payments-v2/stores';
import { memoryKV, type MemoryKV } from './support';

interface Harness {
  kv: MemoryKV;
  deps: RestoreDeps;
  calls: string[];
  reputs: { transferId: string; envelope: string; requiresSeedClose: boolean }[];
  onReput: (transferId: string) => Promise<void>;
}

function makeHarness(): Harness {
  const kv = memoryKV();
  const calls: string[] = [];
  const reputs: Harness['reputs'] = [];
  const h: Harness = {
    kv,
    calls,
    reputs,
    onReput: async () => undefined,
    deps: undefined as unknown as RestoreDeps,
  };
  const get = kv.get.bind(kv);
  kv.get = async <T>(key: string): Promise<T | null> => {
    if (key === STORE_KEYS.intentBackstop) calls.push('read:intents');
    return get<T>(key);
  };
  h.deps = {
    stores: createMachineStores(kv),
    kv,
    reput: async (transferId, envelope, requiresSeedClose) => {
      calls.push(`reput:${transferId}`);
      reputs.push({ transferId, envelope, requiresSeedClose });
      await h.onReput(transferId);
    },
    reseedCheckpoint: async (transferId, opIndex) => {
      calls.push(`checkpoint:${transferId}:${String(opIndex)}`);
      return true;
    },
    decryptPayload: async (envelope) => JSON.parse(envelope.slice('enc:'.length)) as unknown,
    fullRePull: async () => {
      calls.push('rePull');
    },
    attention: (transferId, code) => {
      calls.push(`attention:${transferId}:${code}`);
    },
    onReseedStart: () => {
      calls.push('reseedStart');
    },
  };
  return h;
}

function entry(transferId: string, extra: Partial<IntentBackstopEntry> = {}): IntentBackstopEntry {
  return {
    transferId,
    payloadEnvelope: `enc:${JSON.stringify({ v: 2, kind: 'coin', direct: ['a', 'b'], split: { tokenId: 'c' } })}`,
    requiresSeedClose: false,
    disposition: 'open',
    createdAt: 1,
    ...extra,
  };
}

describe('reseedAndReset (§5.1, #835)', () => {
  it('announces the reseed before it reads the backstop', async () => {
    const h = makeHarness();
    await h.deps.stores.backstop.upsert(entry('t-1'));
    h.calls.length = 0;

    await reseedAndReset(h.deps);

    expect(h.calls[0]).toBe('reseedStart');
    expect(h.calls.indexOf('reseedStart')).toBeLessThan(h.calls.indexOf('read:intents'));
  });

  it('re-PUTs an open entry byte-identically, with its stored flag, and reseeds a split checkpoint at direct.length', async () => {
    const h = makeHarness();
    const direct = entry('direct-1');
    const split = entry('split-1', { requiresSeedClose: true });
    await h.deps.stores.backstop.upsert(direct);
    await h.deps.stores.backstop.upsert(split);

    await reseedAndReset(h.deps);

    expect(h.reputs).toEqual([
      { transferId: 'direct-1', envelope: direct.payloadEnvelope, requiresSeedClose: false },
      { transferId: 'split-1', envelope: split.payloadEnvelope, requiresSeedClose: true },
    ]);
    expect(h.calls).toContain('checkpoint:split-1:2');
    expect(h.calls).not.toContain('checkpoint:direct-1:2');
    expect(await h.deps.stores.backstop.list()).toEqual([direct, split]);
  });

  it('never re-PUTs an entry whose PUT was not acked: pending or unconfirmed', async () => {
    const h = makeHarness();
    await h.deps.stores.backstop.upsert(entry('acked'));
    await h.deps.stores.backstop.upsert(entry('never-acked', { intentPut: 'pending' }));
    await h.deps.stores.backstop.upsert(entry('held', { intentPut: 'unconfirmed' }));

    await reseedAndReset(h.deps);

    expect(h.reputs.map((r) => r.transferId)).toEqual(['acked']);
  });

  it('judges each entry as it is now: one tombstoned or removed after the list is skipped', async () => {
    const h = makeHarness();
    await h.deps.stores.backstop.upsert(entry('first'));
    await h.deps.stores.backstop.upsert(entry('fenced'));
    await h.deps.stores.backstop.upsert(entry('gone'));
    h.onReput = async (transferId) => {
      if (transferId !== 'first') return;
      // A failed send fences itself while the reseed is between entries.
      await h.deps.stores.backstop.patch('fenced', (e) => ({ ...e, disposition: 'abortPending' }));
      await h.deps.stores.backstop.removeByKey('gone');
    };

    await reseedAndReset(h.deps);

    expect(h.reputs.map((r) => r.transferId)).toEqual(['first']);
  });

  it('falls back to the listed entry when the fresh re-read fails', async () => {
    const h = makeHarness();
    const listed = entry('t-1');
    await h.deps.stores.backstop.upsert(listed);
    const get = h.kv.get.bind(h.kv);
    let reads = 0;
    h.kv.get = async <T>(key: string): Promise<T | null> => {
      if (key === STORE_KEYS.intentBackstop && (reads += 1) > 1) throw new Error('injected kv read failure');
      return get<T>(key);
    };

    await reseedAndReset(h.deps);

    expect(h.reputs).toEqual([{ transferId: 't-1', envelope: listed.payloadEnvelope, requiresSeedClose: false }]);
  });

  it('a rejected re-PUT keeps the entry and alerts, then the cursors reset and the full re-pull runs', async () => {
    const h = makeHarness();
    const kept = entry('t-1');
    await h.deps.stores.backstop.upsert(kept);
    await h.kv.set(STORE_KEYS.streamCursor('inventory'), { cursor: 5, syncEpoch: '1' });
    h.onReput = async () => {
      throw new Error('reseed refused');
    };

    await reseedAndReset(h.deps);

    expect(h.calls.slice(-2)).toEqual(['attention:t-1:intent:reseed-rejected', 'rePull']);
    expect(await h.deps.stores.backstop.list()).toEqual([kept]);
    expect(await h.kv.get(STORE_KEYS.streamCursor('inventory'))).toBeNull();
  });
});
