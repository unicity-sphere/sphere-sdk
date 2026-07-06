/**
 * Conformance tests for `ProfileKvAdapter` — the ProfileDatabase impl
 * layered over ProfileKvBackend + LocalBlockCacheFacade.
 *
 * Uses `ProfileKvNode` as the concrete backend (via a temp dir) since
 * the adapter's contract is independent of the backend.
 *
 * Covers:
 *   - connect() derives the shortname from dbNameOverride / privateKey
 *   - connect() invokes backendFactory + blockCacheFactory with the
 *     derived shortname
 *   - Rejects connect() without dbNameOverride or privateKey
 *   - put/get/del/all pass through to the backend
 *   - onReplication fires on local writes AND emitMergeApplied()
 *   - onReplication unsubscribe stops future dispatch
 *   - emitMergeApplied() invalidates localAuthoredKeys
 *   - putEntry/getEntry roundtrip + envelope security-tag downgrade:
 *     · locally-authored + trustLocalClaim:true → verbatim tag
 *     · non-trusted read → force downgrade to 'replicated'
 *     · emitMergeApplied() clears the local-authored set
 *   - getHelia() returns the block cache while connected, null while
 *     shutting down
 *   - close() is idempotent and clears state
 *
 * @module tests/unit/profile/kv/profile-kv-adapter.test
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileKvAdapter } from '../../../../extensions/uxf/profile/kv/profile-kv-adapter';
import { ProfileKvNode } from '../../../../extensions/uxf/profile/kv/profile-kv-node';
import { ProfileError } from '../../../../extensions/uxf/profile/errors';
import type { OpLogEntryEnvelope } from '../../../../extensions/uxf/profile/oplog-entry';
import type { LocalBlockCacheFacade } from '../../../../extensions/uxf/profile/kv/local-block-cache-node';

const enc = (s: string) => new TextEncoder().encode(s);

async function makeTmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'profile-kv-adapter-'));
}

function makeAdapter(
  tmp: string,
  blockCacheStub?: LocalBlockCacheFacade | null,
): ProfileKvAdapter {
  return new ProfileKvAdapter({
    backendFactory: (shortName) =>
      new ProfileKvNode({ directory: `${tmp}/kv-${shortName}` }),
    blockCacheFactory: () => blockCacheStub ?? null,
  });
}

const ANY_PRIVATE_KEY_HEX =
  '0000000000000000000000000000000000000000000000000000000000000001';

describe('ProfileKvAdapter — connect()', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTmp();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('requires backend or backendFactory', () => {
    expect(() => new ProfileKvAdapter({} as never)).toThrow(ProfileError);
  });

  it('rejects connect() without dbNameOverride or privateKey', async () => {
    const kv = makeAdapter(tmp);
    await expect(kv.connect({} as never)).rejects.toThrow(
      /dbNameOverride.*privateKey/,
    );
  });

  it('derives the shortname from privateKey and opens the backend', async () => {
    const captured: string[] = [];
    const kv = new ProfileKvAdapter({
      backendFactory: (shortName) => {
        captured.push(shortName);
        return new ProfileKvNode({ directory: `${tmp}/kv-${shortName}` });
      },
    });
    await kv.connect({ privateKey: ANY_PRIVATE_KEY_HEX });
    expect(kv.isConnected()).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0]).toMatch(/^[a-f0-9]{16}$/);
    await kv.close();
  });

  it('honors dbNameOverride and strips the sphere-profile- prefix', async () => {
    const captured: string[] = [];
    const kv = new ProfileKvAdapter({
      backendFactory: (shortName) => {
        captured.push(shortName);
        return new ProfileKvNode({ directory: `${tmp}/kv-${shortName}` });
      },
    });
    await kv.connect({ dbNameOverride: 'sphere-profile-deadbeefcafeface' });
    expect(captured[0]).toBe('deadbeefcafeface');
    await kv.close();
  });

  it('connect() is idempotent under concurrent callers', async () => {
    const kv = makeAdapter(tmp);
    const a = kv.connect({ privateKey: ANY_PRIVATE_KEY_HEX });
    const b = kv.connect({ privateKey: ANY_PRIVATE_KEY_HEX });
    await Promise.all([a, b]);
    expect(kv.isConnected()).toBe(true);
    await kv.close();
  });
});

describe('ProfileKvAdapter — pass-through ops', () => {
  let tmp: string;
  let kv: ProfileKvAdapter;

  beforeEach(async () => {
    tmp = await makeTmp();
    kv = makeAdapter(tmp);
    await kv.connect({ privateKey: ANY_PRIVATE_KEY_HEX });
  });

  afterEach(async () => {
    await kv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('put/get/del/all pass through to the backend', async () => {
    await kv.put('k', enc('v'));
    expect((await kv.get('k'))!).toEqual(enc('v'));
    const map = await kv.all();
    expect(map.get('k')).toEqual(enc('v'));
    await kv.del('k');
    expect(await kv.get('k')).toBeNull();
  });

  it('rejects operations before connect()', async () => {
    const other = makeAdapter(tmp);
    await expect(other.put('k', enc('v'))).rejects.toThrow(ProfileError);
    await expect(other.get('k')).rejects.toThrow(ProfileError);
    await expect(other.all()).rejects.toThrow(ProfileError);
  });
});

describe('ProfileKvAdapter — onReplication + emitMergeApplied', () => {
  let tmp: string;
  let kv: ProfileKvAdapter;

  beforeEach(async () => {
    tmp = await makeTmp();
    kv = makeAdapter(tmp);
    await kv.connect({ privateKey: ANY_PRIVATE_KEY_HEX });
  });

  afterEach(async () => {
    await kv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('fires on local put/del', async () => {
    const cb = vi.fn();
    kv.onReplication(cb);
    await kv.put('k', enc('v'));
    expect(cb).toHaveBeenCalledTimes(1);
    await kv.del('k');
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('fires on emitMergeApplied()', async () => {
    const cb = vi.fn();
    kv.onReplication(cb);
    kv.emitMergeApplied();
    expect(cb).toHaveBeenCalledTimes(1);
    kv.emitMergeApplied();
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('unsubscribe stops future dispatch', async () => {
    const cb = vi.fn();
    const unsub = kv.onReplication(cb);
    await kv.put('a', enc('1'));
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    await kv.put('b', enc('2'));
    kv.emitMergeApplied();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not block the others', async () => {
    const good = vi.fn();
    kv.onReplication(() => {
      throw new Error('boom');
    });
    kv.onReplication(good);
    await kv.put('k', enc('v'));
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe('ProfileKvAdapter — putEntry / getEntry security-tag downgrade', () => {
  let tmp: string;
  let kv: ProfileKvAdapter;

  beforeEach(async () => {
    tmp = await makeTmp();
    kv = makeAdapter(tmp);
    await kv.connect({ privateKey: ANY_PRIVATE_KEY_HEX });
  });

  afterEach(async () => {
    await kv.close();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // 2021-01-01 in ms — safely above MIN_PLAUSIBLE_TS (2020-01-01).
  const A_PLAUSIBLE_TS = 1_609_459_200_000;
  const buildEntry = (originated: 'user' | 'system' | 'replicated'): OpLogEntryEnvelope => ({
    v: 1,
    // `nametag_register` is a USER action type; `session_receipt` is a
    // SYSTEM action type. Both survive the encode-side ALL_ENTRY_TYPES
    // check and the downgrade path's assertOriginTagReplicated (which
    // gates on originated value, not type category).
    type: originated === 'system' ? 'session_receipt' : 'nametag_register',
    originated,
    ts: A_PLAUSIBLE_TS,
    payload: enc('payload-bytes'),
  });

  it('trustLocalClaim + locally-authored → verbatim tag', async () => {
    await kv.putEntry('local.k', buildEntry('user'));
    const got = await kv.getEntry('local.k', { trustLocalClaim: true });
    expect(got).not.toBeNull();
    expect(got!.originated).toBe('user');
  });

  it('non-trusted read → force downgrade to replicated', async () => {
    await kv.putEntry('local.k', buildEntry('user'));
    const got = await kv.getEntry('local.k'); // no trustLocalClaim
    expect(got).not.toBeNull();
    expect(got!.originated).toBe('replicated');
  });

  it('downgradeAsReplicated forces downgrade even with trustLocalClaim', async () => {
    await kv.putEntry('local.k', buildEntry('system'));
    const got = await kv.getEntry('local.k', {
      trustLocalClaim: true,
      downgradeAsReplicated: true,
    });
    expect(got!.originated).toBe('replicated');
  });

  it('emitMergeApplied() clears the local-authored set', async () => {
    await kv.putEntry('local.k', buildEntry('user'));
    // First read WITH trust — locally-authored, returns tag verbatim.
    const before = await kv.getEntry('local.k', { trustLocalClaim: true });
    expect(before!.originated).toBe('user');
    // Simulate a merge event landing.
    kv.emitMergeApplied();
    // Same read now downgrades — the merge could have overwritten our key.
    const after = await kv.getEntry('local.k', { trustLocalClaim: true });
    expect(after!.originated).toBe('replicated');
  });

  it('markLocallyAuthored() marks a key trusted without a put', async () => {
    // Author from outside the adapter path, then mark trusted.
    await kv.putEntry('local.k', buildEntry('system'));
    kv.emitMergeApplied(); // clears the auto-marked entry
    // Baseline: after emitMergeApplied the tag is downgraded.
    expect((await kv.getEntry('local.k', { trustLocalClaim: true }))!.originated).toBe(
      'replicated',
    );
    // Manually re-mark as locally-authored — the next trusted read is verbatim.
    kv.markLocallyAuthored('local.k');
    expect((await kv.getEntry('local.k', { trustLocalClaim: true }))!.originated).toBe(
      'system',
    );
  });

  it('getEntry(missing) returns null', async () => {
    expect(await kv.getEntry('no-such-key')).toBeNull();
  });
});

describe('ProfileKvAdapter — getHelia + close lifecycle', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await makeTmp();
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('returns null when no block cache was provided', async () => {
    const kv = makeAdapter(tmp);
    await kv.connect({ privateKey: ANY_PRIVATE_KEY_HEX });
    expect(kv.getHelia()).toBeNull();
    await kv.close();
  });

  it('returns the block cache facade while connected', async () => {
    const stub: LocalBlockCacheFacade = {
      blockstore: {
        get: async () => new Uint8Array(),
        put: async () => undefined,
        has: async () => false,
      },
    };
    const kv = makeAdapter(tmp, stub);
    await kv.connect({ privateKey: ANY_PRIVATE_KEY_HEX });
    const got = kv.getHelia();
    expect(got).toBe(stub);
    await kv.close();
  });

  it('close() is idempotent', async () => {
    const kv = makeAdapter(tmp);
    await kv.connect({ privateKey: ANY_PRIVATE_KEY_HEX });
    await kv.close();
    await kv.close();
    expect(kv.isConnected()).toBe(false);
  });
});
