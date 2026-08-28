/**
 * The durable-client-state generation rename — the whole 3.x local migration.
 *
 * The superseded `pv2:` keys hold intents, checkpoints and journals built
 * against a token wire format the network no longer accepts. Leaving them
 * readable is worse than losing them: the sync-epoch latch lives there too, so
 * after a backend reset the surviving latch makes the session see a CHANGED
 * epoch and run the restore protocol, which re-PUTs every locally-open intent
 * into the fresh backend. Those intents can never complete and can never be
 * dropped — a permanent pending row holding its sources reserved.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileStorageProvider } from '../../../impl/nodejs/storage/FileStorageProvider';
import { createScopedKV, STORE_KEYS, sweepSupersededState } from '../../../modules/payments-v2/stores';

const NET = 'testnet2';
const PUBKEY = '02'.repeat(17).slice(0, 66);

const dirs: string[] = [];

function storageProvider(): FileStorageProvider {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pv2-generation-'));
  dirs.push(dataDir);
  return new FileStorageProvider({ dataDir });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('durable client state — generation rename', () => {
  it('drops every superseded pv2: key while leaving the current generation intact', async () => {
    const storage = storageProvider();
    await storage.set(`pv2:${NET}:${PUBKEY}:intents`, '["a stale open intent"]');
    await storage.set(`pv2:${NET}:${PUBKEY}:${STORE_KEYS.epochLatch}`, '"epoch-7"');
    const kv = createScopedKV(storage, NET, PUBKEY);
    await kv.set(STORE_KEYS.intentBackstop, ['a live intent']);

    await sweepSupersededState(storage);

    expect(await storage.get(`pv2:${NET}:${PUBKEY}:intents`)).toBeNull();
    expect(await storage.get(`pv2:${NET}:${PUBKEY}:${STORE_KEYS.epochLatch}`)).toBeNull();
    // The trap this guards: clear() matches by startsWith, so a prefix like
    // "pv2:g2:" would have deleted itself on the way past.
    expect(await kv.get(STORE_KEYS.intentBackstop)).toEqual(['a live intent']);
  });

  it('leaves the epoch latch unreadable, so a reset fires no restore at all', async () => {
    const storage = storageProvider();
    await storage.set(`pv2:${NET}:${PUBKEY}:${STORE_KEYS.epochLatch}`, '"epoch-7"');

    await sweepSupersededState(storage);

    // null is what makes noteEpoch take its `previous === null` early return.
    expect(await createScopedKV(storage, NET, PUBKEY).get(STORE_KEYS.epochLatch)).toBeNull();
  });

  it('never touches keys outside the payments prefixes', async () => {
    const storage = storageProvider();
    await storage.set('sphere:mnemonic', 'do not delete me');
    await storage.set('identity:0', '{"chainPubkey":"02ab"}');

    await sweepSupersededState(storage);

    expect(await storage.get('sphere:mnemonic')).toBe('do not delete me');
    expect(await storage.get('identity:0')).toBe('{"chainPubkey":"02ab"}');
  });

  it('is idempotent — a second sweep is a no-op, not an error', async () => {
    const storage = storageProvider();
    await storage.set(`pv2:${NET}:${PUBKEY}:intents`, '["stale"]');

    await sweepSupersededState(storage);
    await expect(sweepSupersededState(storage)).resolves.toBeUndefined();
  });
});
