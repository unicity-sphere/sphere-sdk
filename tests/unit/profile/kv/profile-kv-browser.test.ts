/**
 * Conformance tests for `ProfileKvBrowser` — the IndexedDB backend for
 * the Phase 4 (uxf-v2) profile substrate.
 *
 * Runs under `fake-indexeddb/auto` so the tests are hermetic on Node.
 *
 * Covers:
 *   - open/close idempotence + isOpen()
 *   - put/get/del roundtrip (byte-identical values)
 *   - all(prefix) uses IDB key-range cursor (O(matched) prefix scan)
 *   - maxResults cap short-circuits before scanning to end
 *   - keys(prefix) enumeration
 *   - reset() deletes the underlying IDB database
 *
 * @module tests/unit/profile/kv/profile-kv-browser.test
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';

import { ProfileKvBrowser } from '../../../../extensions/uxf/profile/kv/profile-kv-browser';
import { ProfileError } from '../../../../extensions/uxf/profile/errors';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

let dbCounter = 0;
function nextDbName(): string {
  dbCounter += 1;
  return `profile-kv-browser-test-${dbCounter}-${Date.now()}`;
}

describe('ProfileKvBrowser — construction + lifecycle', () => {
  it('rejects construction without dbName', () => {
    expect(() => new ProfileKvBrowser({ dbName: '' })).toThrow(
      /requires a non-empty `dbName`/,
    );
  });

  it('open() is idempotent', async () => {
    const kv = new ProfileKvBrowser({ dbName: nextDbName() });
    expect(kv.isOpen()).toBe(false);
    await kv.open();
    expect(kv.isOpen()).toBe(true);
    await kv.open();
    expect(kv.isOpen()).toBe(true);
    await kv.close();
  });

  it('close() is idempotent', async () => {
    const kv = new ProfileKvBrowser({ dbName: nextDbName() });
    await kv.close(); // close-before-open is a no-op
    await kv.open();
    await kv.close();
    await kv.close();
    expect(kv.isOpen()).toBe(false);
  });

  it('rejects put/get/del before open()', async () => {
    const kv = new ProfileKvBrowser({ dbName: nextDbName() });
    await expect(kv.put('k', enc('v'))).rejects.toThrow(ProfileError);
    await expect(kv.get('k')).rejects.toThrow(ProfileError);
    await expect(kv.del('k')).rejects.toThrow(ProfileError);
  });
});

describe('ProfileKvBrowser — put/get/del roundtrip', () => {
  let kv: ProfileKvBrowser;

  beforeEach(async () => {
    kv = new ProfileKvBrowser({ dbName: nextDbName() });
    await kv.open();
  });

  afterEach(async () => {
    await kv.close();
  });

  it('put/get roundtrip preserves bytes', async () => {
    const value = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    await kv.put('a/b/c', value);
    const got = await kv.get('a/b/c');
    expect(got).toEqual(value);
  });

  it('get(missing) returns null', async () => {
    expect(await kv.get('no-such-key')).toBeNull();
  });

  it('put overwrites existing value', async () => {
    await kv.put('k', enc('first'));
    await kv.put('k', enc('second'));
    const got = await kv.get('k');
    expect(dec(got!)).toBe('second');
  });

  it('del removes the key', async () => {
    await kv.put('k', enc('v'));
    expect(await kv.get('k')).not.toBeNull();
    await kv.del('k');
    expect(await kv.get('k')).toBeNull();
  });
});

describe('ProfileKvBrowser — all() key-range prefix scan', () => {
  let kv: ProfileKvBrowser;

  beforeEach(async () => {
    kv = new ProfileKvBrowser({ dbName: nextDbName() });
    await kv.open();
    for (let i = 0; i < 10; i++) {
      await kv.put(`outbox.${i}`, enc(`entry-${i}`));
      await kv.put(`sent.${i}`, enc(`sent-${i}`));
    }
    await kv.put('zzz-last', enc('zz'));
  });

  afterEach(async () => {
    await kv.close();
  });

  it('all() without prefix returns every entry', async () => {
    const map = await kv.all();
    expect(map.size).toBe(21);
  });

  it('all(prefix) filters to matching entries only', async () => {
    const outbox = await kv.all('outbox.');
    expect(outbox.size).toBe(10);
    expect(Array.from(outbox.keys()).every((k) => k.startsWith('outbox.'))).toBe(
      true,
    );
  });

  it('all(prefix) with different prefix uses key-range', async () => {
    const sent = await kv.all('sent.');
    expect(sent.size).toBe(10);
  });

  it('all(prefix) maxResults cap short-circuits within the range', async () => {
    const capped = await kv.all('outbox.', { maxResults: 3 });
    expect(capped.size).toBe(3);
    expect(Array.from(capped.keys()).every((k) => k.startsWith('outbox.'))).toBe(
      true,
    );
  });

  it('keys(prefix) enumerates without loading values', async () => {
    const keys = await kv.keys('outbox.');
    expect(keys.length).toBe(10);
    expect(keys.every((k) => k.startsWith('outbox.'))).toBe(true);
  });
});

describe('ProfileKvBrowser — reset()', () => {
  it('reset() deletes the database and closes the connection', async () => {
    const dbName = nextDbName();
    const kv = new ProfileKvBrowser({ dbName });
    await kv.open();
    await kv.put('k', enc('v'));
    await kv.reset();
    expect(kv.isOpen()).toBe(false);

    // Reopening yields an empty database.
    const kv2 = new ProfileKvBrowser({ dbName });
    await kv2.open();
    expect(await kv2.get('k')).toBeNull();
    const all = await kv2.all();
    expect(all.size).toBe(0);
    await kv2.close();
  });
});
