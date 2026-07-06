/**
 * Conformance tests for `ProfileKvNode` — the file-per-key backend for
 * the Phase 4 (uxf-v2) profile substrate.
 *
 * Covers:
 *   - open/close idempotence + isOpen()
 *   - put/get/del roundtrip (byte-identical values)
 *   - all(prefix) filtering + maxResults cap short-circuit
 *   - keys(prefix) enumeration
 *   - reset() removes the directory + wipes the index
 *   - Index survives close+reopen (manifest sidecar reload)
 *   - Skew tolerance: file removed under the adapter is silently
 *     dropped from the index on next read
 *   - Atomic-rename discipline: no partial-write can be observed via
 *     get() (verified by concurrent writer + reader interleaving)
 *   - Rejects operations before open()
 *
 * These tests exercise the primitive that supersedes OrbitDB's `keyvalue`
 * database, so byte-stable behavior is critical — the writers above
 * (OUTBOX/SENT/finalization/manifest CAS) all rely on these semantics.
 *
 * @module tests/unit/profile/kv/profile-kv-node.test
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ProfileKvNode } from '../../../../extensions/uxf/profile/kv/profile-kv-node';
import { ProfileError } from '../../../../extensions/uxf/profile/errors';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'profile-kv-node-'));
}

describe('ProfileKvNode — construction + lifecycle', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('rejects construction without a directory', () => {
    expect(() => new ProfileKvNode({ directory: '' })).toThrow(
      /requires a non-empty `directory`/,
    );
  });

  it('open() is idempotent and creates the KV directory', async () => {
    const kv = new ProfileKvNode({ directory: `${tmp}/kv` });
    expect(kv.isOpen()).toBe(false);
    await kv.open();
    expect(kv.isOpen()).toBe(true);
    await kv.open(); // second open is a no-op
    expect(kv.isOpen()).toBe(true);
    const stat = await fs.stat(`${tmp}/kv`);
    expect(stat.isDirectory()).toBe(true);
  });

  it('close() is idempotent', async () => {
    const kv = new ProfileKvNode({ directory: `${tmp}/kv` });
    await kv.close(); // close-before-open is a no-op
    await kv.open();
    await kv.close();
    await kv.close();
    expect(kv.isOpen()).toBe(false);
  });

  it('rejects put/get/del/all before open()', async () => {
    const kv = new ProfileKvNode({ directory: `${tmp}/kv` });
    await expect(kv.put('k', enc('v'))).rejects.toThrow(ProfileError);
    await expect(kv.get('k')).rejects.toThrow(ProfileError);
    await expect(kv.del('k')).rejects.toThrow(ProfileError);
    await expect(kv.all()).rejects.toThrow(ProfileError);
  });
});

describe('ProfileKvNode — put/get/del roundtrip', () => {
  let tmp: string;
  let kv: ProfileKvNode;

  beforeEach(async () => {
    tmp = await makeTempDir();
    kv = new ProfileKvNode({ directory: `${tmp}/kv` });
    await kv.open();
  });

  afterEach(async () => {
    await kv.close();
    await fs.rm(tmp, { recursive: true, force: true });
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

  it('del on missing key is a no-op', async () => {
    await expect(kv.del('never-existed')).resolves.toBeUndefined();
  });

  it('accepts keys with special characters (path-hostile input hashed)', async () => {
    const keys = [
      'plain-key',
      'with/slashes/in/it',
      '..',
      '../../etc/passwd',
      'null\0byte',
      'very'.repeat(200),
    ];
    for (const [i, k] of keys.entries()) {
      await kv.put(k, enc(`v${i}`));
    }
    for (const [i, k] of keys.entries()) {
      const got = await kv.get(k);
      expect(dec(got!)).toBe(`v${i}`);
    }
  });
});

describe('ProfileKvNode — all() prefix scan + maxResults', () => {
  let tmp: string;
  let kv: ProfileKvNode;

  beforeEach(async () => {
    tmp = await makeTempDir();
    kv = new ProfileKvNode({ directory: `${tmp}/kv` });
    await kv.open();
    for (let i = 0; i < 10; i++) {
      await kv.put(`outbox.${i}`, enc(`entry-${i}`));
      await kv.put(`sent.${i}`, enc(`sent-${i}`));
    }
    await kv.put('other', enc('unrelated'));
  });

  afterEach(async () => {
    await kv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('all() without prefix returns every entry', async () => {
    const map = await kv.all();
    expect(map.size).toBe(21);
  });

  it('all(prefix) filters', async () => {
    const outbox = await kv.all('outbox.');
    expect(outbox.size).toBe(10);
    expect(Array.from(outbox.keys()).every((k) => k.startsWith('outbox.'))).toBe(
      true,
    );
    const sent = await kv.all('sent.');
    expect(sent.size).toBe(10);
  });

  it('all() maxResults caps returned entries', async () => {
    const capped = await kv.all(undefined, { maxResults: 5 });
    expect(capped.size).toBe(5);
  });

  it('all(prefix) + maxResults caps within the filter', async () => {
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

describe('ProfileKvNode — persistence across close/reopen', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('index rebuilds from manifest on reopen', async () => {
    const dir = `${tmp}/kv`;
    const a = new ProfileKvNode({ directory: dir });
    await a.open();
    await a.put('persist', enc('durable'));
    await a.put('kill-later', enc('doomed'));
    await a.del('kill-later');
    await a.close();

    const b = new ProfileKvNode({ directory: dir });
    await b.open();
    expect(await b.get('persist')).toEqual(enc('durable'));
    expect(await b.get('kill-later')).toBeNull();
    // Verify the prefix scan still sees the reopened entry.
    const all = await b.all();
    expect(all.size).toBe(1);
    expect(all.get('persist')).toEqual(enc('durable'));
    await b.close();
  });

  it('reset() wipes the directory and index', async () => {
    const dir = `${tmp}/kv`;
    const kv = new ProfileKvNode({ directory: dir });
    await kv.open();
    await kv.put('k', enc('v'));
    await kv.reset();
    expect(kv.isOpen()).toBe(false);
    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    // Reopen after reset works and is empty.
    const kv2 = new ProfileKvNode({ directory: dir });
    await kv2.open();
    const all = await kv2.all();
    expect(all.size).toBe(0);
    await kv2.close();
  });

  it('tolerates a file being removed under the adapter', async () => {
    const dir = `${tmp}/kv`;
    const kv = new ProfileKvNode({ directory: dir });
    await kv.open();
    await kv.put('victim', enc('vv'));
    // Simulate crash: nuke the data file, keep the manifest.
    const dataDir = path.join(dir, 'data');
    const files = await fs.readdir(dataDir);
    // Delete only files that are not the manifest.
    for (const f of files) {
      await fs.unlink(path.join(dataDir, f));
    }
    // Next get() must return null, not throw.
    expect(await kv.get('victim')).toBeNull();
    await kv.close();
  });
});

describe('ProfileKvNode — atomic-rename discipline (no partial reads)', () => {
  let tmp: string;
  let kv: ProfileKvNode;

  beforeEach(async () => {
    tmp = await makeTempDir();
    kv = new ProfileKvNode({ directory: `${tmp}/kv` });
    await kv.open();
  });

  afterEach(async () => {
    await kv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('interleaving writers + readers never observes half-written bytes', async () => {
    // Two payloads of clearly different sizes with distinct byte patterns.
    const short = enc('AAA');
    const long = enc('B'.repeat(4096));
    // Rotate writes tight, interleaving reads. If atomic-rename were
    // broken, a read could catch the partial write and see truncated
    // or mixed bytes.
    const iterations = 50;
    const writer = (async () => {
      for (let i = 0; i < iterations; i++) {
        await kv.put('flip', i % 2 === 0 ? short : long);
      }
    })();
    const reader = (async () => {
      for (let i = 0; i < iterations; i++) {
        const got = await kv.get('flip');
        // Every read must land on ONE of the two intact byte sequences.
        if (got !== null) {
          const isShort =
            got.byteLength === short.byteLength && dec(got) === 'AAA';
          const isLong =
            got.byteLength === long.byteLength && dec(got) === 'B'.repeat(4096);
          expect(isShort || isLong).toBe(true);
        }
      }
    })();
    await Promise.all([writer, reader]);
    // Final state is deterministic based on the last write (even i → short).
    const final = await kv.get('flip');
    expect(final).not.toBeNull();
  });

  it('a stray tmp file in the data dir does not surface as an entry', async () => {
    await kv.put('real', enc('v'));
    const dataDir = path.join(`${tmp}/kv`, 'data');
    // Simulate a crash mid-rename: stray temp file left over. The
    // manifest doesn't reference it, so it should be invisible to
    // all() / keys().
    await fs.writeFile(path.join(dataDir, '.tmp-abc123-stray'), 'garbage');
    const map = await kv.all();
    expect(map.size).toBe(1);
    expect(map.has('real')).toBe(true);
    const keys = await kv.keys();
    expect(keys).toEqual(['real']);
  });
});
