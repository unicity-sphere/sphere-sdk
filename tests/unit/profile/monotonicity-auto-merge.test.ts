/**
 * Issue #264 — focused unit tests for the auto-merge primitives
 * introduced by `fix(profile)(#264): auto-merge monotonicity
 * violations in flush-scheduler`.
 *
 * Two surfaces are pinned here:
 *
 *   1. `unionOpStateWithSentWins(current, previous)` — the helper
 *      that constructs the merged `OperationalState` so the
 *      per-entry-key OrbitDB write doesn't tombstone live entries.
 *      Tests cover the SENT-wins-over-OUTBOX dedup rule (the spec's
 *      explicit ask), id-based union behavior across all collections,
 *      no-id fall-through, and the `droppedOutboxIds` audit output.
 *
 *   2. `enablePointerWinBroadcasts` default-OFF policy — verified at
 *      the ProfilePointerLayer + lifecycle-manager seam. The publisher
 *      side (`storage:pointer-published` emit) MUST stay silent when
 *      the flag is unset or explicitly false, and MUST fire when the
 *      flag is explicitly `true`. Strict `=== true` coercion is
 *      asserted so accidental truthy non-boolean values (`'true'`,
 *      `1`) fail closed.
 *
 * Sibling-adoption test cases from #263 were never landed on this
 * branch (the `siblingHighestV` plumbing was intentionally omitted
 * per #264 — see commit `perf(profile)(#264): fast-path skip Step B
 * discovery on attempts === 0`). There is therefore no
 * `reconcile-and-publish.test.ts` to drop sibling cases from on this
 * branch; the issue's "drop the 2 sibling-adoption cases" instruction
 * is satisfied by construction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  type OpStateArrays,
  unionOpStateWithSentWins,
} from '../../../extensions/uxf/profile/profile-token-storage/flush-scheduler';
import type { ProfileDatabase, OrbitDbConfig } from '../../../extensions/uxf/profile/types';
import type { FullIdentity } from '../../../types';
import { ProfileTokenStorageProvider } from '../../../extensions/uxf/profile/profile-token-storage-provider';
import {
  buildPointerSigner,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  ProfilePointerLayer,
  type PointerSigner,
} from '../../../extensions/uxf/profile/aggregator-pointer';
import type { StorageEvent } from '../../../storage/storage-provider';

// ---------------------------------------------------------------------------
// Test 1: unionOpStateWithSentWins
// ---------------------------------------------------------------------------

function emptyOpState(): OpStateArrays {
  return {
    tombstones: [],
    outbox: [],
    sent: [],
    invalid: [],
    history: [],
    mintOutbox: [],
    invalidatedNametags: [],
    audit: [],
    finalizationQueue: [],
  };
}

describe('unionOpStateWithSentWins — SENT-wins dedup (#264)', () => {
  it('returns empty arrays when both inputs are empty', () => {
    const { merged, droppedOutboxIds } = unionOpStateWithSentWins(
      emptyOpState(),
      emptyOpState(),
    );
    expect(droppedOutboxIds).toEqual([]);
    for (const key of Object.keys(merged) as (keyof OpStateArrays)[]) {
      expect(merged[key]).toEqual([]);
    }
  });

  it('unions OUTBOX entries by id; current value wins on collision', () => {
    const prev: OpStateArrays = {
      ...emptyOpState(),
      outbox: [
        { id: 'transfer-A', status: 'pending', oldField: 'old' },
        { id: 'transfer-B', status: 'pending' },
      ],
    };
    const curr: OpStateArrays = {
      ...emptyOpState(),
      outbox: [
        { id: 'transfer-A', status: 'submitted', newField: 'new' },
      ],
    };
    const { merged } = unionOpStateWithSentWins(curr, prev);
    // Both ids present after the union.
    const byId = new Map<string, unknown>();
    for (const e of merged.outbox) {
      const id = (e as { id: string }).id;
      byId.set(id, e);
    }
    expect(byId.size).toBe(2);
    // transfer-A from CURRENT (newer view wins on conflict).
    expect(byId.get('transfer-A')).toEqual({
      id: 'transfer-A',
      status: 'submitted',
      newField: 'new',
    });
    // transfer-B carried through from previous.
    expect(byId.get('transfer-B')).toEqual({ id: 'transfer-B', status: 'pending' });
  });

  it('drops OUTBOX entries whose id matches a SENT entry (SENT wins)', () => {
    const prev: OpStateArrays = {
      ...emptyOpState(),
      outbox: [
        { id: 'transfer-A', status: 'pending' }, // stale — has moved to SENT
        { id: 'transfer-C', status: 'pending' }, // still live in OUTBOX
      ],
    };
    const curr: OpStateArrays = {
      ...emptyOpState(),
      sent: [
        {
          _schemaVersion: 'uxf-1',
          id: 'transfer-A',
          tokenIds: ['tk1'],
          bundleCid: 'bafy-sent-A',
        },
      ],
    };
    const { merged, droppedOutboxIds } = unionOpStateWithSentWins(curr, prev);
    // SENT entry is preserved.
    expect(merged.sent).toHaveLength(1);
    expect((merged.sent[0] as { id: string }).id).toBe('transfer-A');
    // OUTBOX no longer has the SENT-shadowed id.
    const outboxIds = merged.outbox.map((e) => (e as { id: string }).id);
    expect(outboxIds).not.toContain('transfer-A');
    expect(outboxIds).toContain('transfer-C');
    // Dropped id is surfaced for operator audit.
    expect(droppedOutboxIds).toContain('transfer-A');
    expect(droppedOutboxIds).not.toContain('transfer-C');
  });

  it('drops MULTIPLE OUTBOX entries when several SENT entries shadow them', () => {
    const prev: OpStateArrays = {
      ...emptyOpState(),
      outbox: [
        { id: 'transfer-A', status: 'pending' },
        { id: 'transfer-B', status: 'pending' },
        { id: 'transfer-C', status: 'pending' },
      ],
    };
    const curr: OpStateArrays = {
      ...emptyOpState(),
      sent: [
        { _schemaVersion: 'uxf-1', id: 'transfer-A', tokenIds: ['tk1'], bundleCid: 'b1' },
        { _schemaVersion: 'uxf-1', id: 'transfer-B', tokenIds: ['tk2'], bundleCid: 'b2' },
      ],
    };
    const { merged, droppedOutboxIds } = unionOpStateWithSentWins(curr, prev);
    expect(merged.outbox.map((e) => (e as { id: string }).id)).toEqual(['transfer-C']);
    expect(droppedOutboxIds.sort()).toEqual(['transfer-A', 'transfer-B']);
  });

  it('unions SENT entries by id; current wins on collision', () => {
    const prev: OpStateArrays = {
      ...emptyOpState(),
      sent: [
        { _schemaVersion: 'uxf-1', id: 'transfer-A', tokenIds: ['tk-old'], bundleCid: 'b-old' },
        { _schemaVersion: 'uxf-1', id: 'transfer-B', tokenIds: ['tk-B'], bundleCid: 'b-B' },
      ],
    };
    const curr: OpStateArrays = {
      ...emptyOpState(),
      sent: [
        { _schemaVersion: 'uxf-1', id: 'transfer-A', tokenIds: ['tk-new'], bundleCid: 'b-new' },
      ],
    };
    const { merged } = unionOpStateWithSentWins(curr, prev);
    const byId = new Map<string, unknown>();
    for (const e of merged.sent) byId.set((e as { id: string }).id, e);
    expect(byId.size).toBe(2);
    // current wins for transfer-A
    expect((byId.get('transfer-A') as { tokenIds: string[] }).tokenIds).toEqual(['tk-new']);
    expect((byId.get('transfer-A') as { bundleCid: string }).bundleCid).toBe('b-new');
    // previous carried for transfer-B
    expect((byId.get('transfer-B') as { tokenIds: string[] }).tokenIds).toEqual(['tk-B']);
  });

  it('unions TOMBSTONES by tokenId; non-tokenId entries dedup by JSON', () => {
    const prev: OpStateArrays = {
      ...emptyOpState(),
      tombstones: [
        { tokenId: 'tk1', reason: 'old' },
        { tokenId: 'tk2', reason: 'previous' },
        { meta: 'no-tokenId-old' },
      ],
    };
    const curr: OpStateArrays = {
      ...emptyOpState(),
      tombstones: [
        { tokenId: 'tk1', reason: 'new' }, // collides — current wins
        { meta: 'no-tokenId-new' },
        { meta: 'no-tokenId-old' }, // same JSON as previous → deduped
      ],
    };
    const { merged } = unionOpStateWithSentWins(curr, prev);
    const byTokenId = new Map<string, unknown>();
    const noId: unknown[] = [];
    for (const e of merged.tombstones) {
      const tid = (e as { tokenId?: string }).tokenId;
      if (typeof tid === 'string') byTokenId.set(tid, e);
      else noId.push(e);
    }
    expect(byTokenId.size).toBe(2);
    expect(byTokenId.get('tk1')).toEqual({ tokenId: 'tk1', reason: 'new' });
    expect(byTokenId.get('tk2')).toEqual({ tokenId: 'tk2', reason: 'previous' });
    // Two distinct no-tokenId meta entries (old + new), dup of old removed.
    expect(noId).toHaveLength(2);
    const metaValues = noId.map((e) => (e as { meta: string }).meta).sort();
    expect(metaValues).toEqual(['no-tokenId-new', 'no-tokenId-old']);
  });

  it('keeps audit and finalizationQueue entries with stable id semantics', () => {
    const prev: OpStateArrays = {
      ...emptyOpState(),
      audit: [{ id: 'audit-1', op: 'prev' }],
      finalizationQueue: [{ id: 'fq-1', payload: 'prev' }],
    };
    const curr: OpStateArrays = {
      ...emptyOpState(),
      audit: [{ id: 'audit-2', op: 'curr' }, { id: 'audit-1', op: 'curr-overwrite' }],
      finalizationQueue: [{ id: 'fq-2', payload: 'curr' }],
    };
    const { merged } = unionOpStateWithSentWins(curr, prev);
    const auditById = new Map<string, unknown>();
    for (const e of merged.audit) auditById.set((e as { id: string }).id, e);
    expect(auditById.size).toBe(2);
    // current wins for audit-1
    expect(auditById.get('audit-1')).toEqual({ id: 'audit-1', op: 'curr-overwrite' });
    expect(auditById.get('audit-2')).toEqual({ id: 'audit-2', op: 'curr' });
    const fqById = new Map<string, unknown>();
    for (const e of merged.finalizationQueue) fqById.set((e as { id: string }).id, e);
    expect(fqById.size).toBe(2);
  });

  it('intra-current duplicate ids collapse to one entry per id (regression test for prior amplification-minimal variant)', () => {
    // Steelman finding (round 2): a prior remediation variant lost the
    // Map-based intra-source dedup, so `currentOp.outbox = [{id:A,v:1},
    // {id:A,v:2}]` produced TWO entries in merged.outbox. This test
    // pins the naive-Map contract: duplicate ids within a single
    // source collapse, with later-inserted winning.
    const curr: OpStateArrays = {
      ...emptyOpState(),
      outbox: [
        { id: 'A', v: 1 },
        { id: 'A', v: 2 }, // intra-current dup
        { id: 'B', v: 1 },
      ],
    };
    const prev: OpStateArrays = emptyOpState();
    const { merged } = unionOpStateWithSentWins(curr, prev);
    // 2 ids → 2 entries (NOT 3).
    expect(merged.outbox).toHaveLength(2);
    const byId = new Map<string, unknown>();
    for (const e of merged.outbox) byId.set((e as { id: string }).id, e);
    expect(byId.size).toBe(2);
    // Last-inserted wins for the duplicate id.
    expect((byId.get('A') as { v: number }).v).toBe(2);
    expect((byId.get('B') as { v: number }).v).toBe(1);
  });

  it('empty-string id is dedup-able (regression test for prior amplification-minimal variant)', () => {
    // Steelman finding (round 2): the prior variant routed `id: ''`
    // through the no-id bucket, losing dedup. Naive Map treats empty
    // strings as valid keys. Two entries with `id: ''` collapse.
    const curr: OpStateArrays = {
      ...emptyOpState(),
      outbox: [{ id: '', x: 'curr' }],
    };
    const prev: OpStateArrays = {
      ...emptyOpState(),
      outbox: [{ id: '', x: 'prev' }],
    };
    const { merged } = unionOpStateWithSentWins(curr, prev);
    // One entry with id '' (collapsed), current wins.
    expect(merged.outbox).toHaveLength(1);
    expect((merged.outbox[0] as { id: string; x: string }).id).toBe('');
    expect((merged.outbox[0] as { x: string }).x).toBe('curr');
  });

  it('SENT-wins triggers only on string id equality — non-string ids are ignored', () => {
    // `readId` accepts ANY string (including empty); SENT-wins fires
    // for both. But non-string ids (null, undefined, numeric, object)
    // are NOT treated as valid ids — they fall through to the no-id
    // bucket and never match SENT entries.
    const prev: OpStateArrays = {
      ...emptyOpState(),
      outbox: [
        { id: null as unknown as string, status: 'pending' },
        { id: undefined as unknown as string, status: 'pending' },
        { id: 42 as unknown as string, status: 'pending' },
        { id: 'transfer-A', status: 'pending' },
      ],
    };
    const curr: OpStateArrays = {
      ...emptyOpState(),
      sent: [
        { _schemaVersion: 'uxf-1', id: 'transfer-A', tokenIds: ['tk'], bundleCid: 'b' },
      ],
    };
    const { merged, droppedOutboxIds } = unionOpStateWithSentWins(curr, prev);
    // SENT-wins drops transfer-A from outbox; the 3 non-string-id
    // entries fall through to the no-id bucket and survive unchanged.
    expect(merged.outbox).toHaveLength(3);
    expect(droppedOutboxIds).toEqual(['transfer-A']);
    // None of the 3 surviving outbox entries should be the dropped 'transfer-A'.
    const survivingIds = merged.outbox.map((e) => (e as { id: unknown }).id);
    expect(survivingIds).not.toContain('transfer-A');
    expect(survivingIds).toContain(null);
    expect(survivingIds).toContain(undefined);
    expect(survivingIds).toContain(42);
  });
});

// ---------------------------------------------------------------------------
// Test 2: enablePointerWinBroadcasts default-OFF policy
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};
const FAKE_CID = 'bafkreigh2akiscaildc6ovwc6m3fy5puxhxcw7qveyf2nbn7xmqwfajeuy';

function createMockDb(): ProfileDatabase & { _store: Map<string, Uint8Array> } {
  const store = new Map<string, Uint8Array>();
  return {
    _store: store,
    async connect(_config: OrbitDbConfig) {},
    async put(key: string, value: Uint8Array) { store.set(key, value); },
    async get(key: string) { return store.get(key) ?? null; },
    async del(key: string) { store.delete(key); },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async close() {},
    onReplication() { return () => {}; },
    isConnected() { return true; },
  } as ProfileDatabase & { _store: Map<string, Uint8Array> };
}

async function buildRealSigner(): Promise<PointerSigner> {
  const seed = new Uint8Array(32).fill(0x42);
  const masterKey = createMasterPrivateKey(seed);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  return buildPointerSigner(keyMaterial.signingSeed);
}

/**
 * Build a real `ProfilePointerLayer` with `publish` stubbed to a
 * deterministic success. The flag plumbing IS tested via the real
 * constructor's normalized-config snapshot.
 */
async function buildRealPointerWithFlag(
  enablePointerWinBroadcasts: boolean | undefined,
): Promise<ProfilePointerLayer> {
  const signer = await buildRealSigner();
  const layer = new ProfilePointerLayer({
    keyMaterial: { signingSeed: new Uint8Array(32), xorSeed: new Uint8Array(32) } as never,
    signer,
    aggregatorClient: {} as never,
    trustBase: {} as never,
    flagStore: {} as never,
    mutex: {} as never,
    decodeCid: (() => ({ bytes: new Uint8Array(0) })) as never,
    fetchCar: (async () => ({ bytes: new Uint8Array(0) })) as never,
    fetchAndJoin: async () => {},
    readLocalVersion: async () => 0 as never,
    persistLocalVersion: async () => {},
    resolveRemoteCid: async () => new Uint8Array(0),
    config:
      enablePointerWinBroadcasts === undefined
        ? undefined
        : { enablePointerWinBroadcasts },
  });
  // Stub publish to a deterministic success.
  (layer as unknown as { publish: () => Promise<unknown> }).publish = async () => ({
    version: 11,
    attemptsUsed: 1,
  });
  return layer;
}

async function createHarness(pointer: ProfilePointerLayer): Promise<{
  events: StorageEvent[];
  publish: (cid: string) => Promise<{ ok: boolean; transient: boolean; code?: string }>;
  shutdown: () => Promise<void>;
}> {
  const db = createMockDb();
  const provider = new ProfileTokenStorageProvider(
    db,
    new Uint8Array(32).fill(0x11),
    ['https://mock-ipfs.test'],
    {
      config: { orbitDb: { privateKey: TEST_PRIVATE_KEY }, ipnsSnapshot: false },
      addressId: 'test',
      encrypt: true,
      getPointerLayer: () => pointer,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  await provider.initialize();
  const events: StorageEvent[] = [];
  if (typeof provider.onEvent === 'function') {
    provider.onEvent((event) => { events.push(event); });
  }
  const lifecycle = (provider as unknown as {
    lifecycleManager: {
      publishAggregatorPointerBestEffort(
        cid: string,
      ): Promise<{ ok: boolean; transient: boolean; code?: string }>;
    };
  }).lifecycleManager;
  return {
    events,
    publish: (cid: string) => lifecycle.publishAggregatorPointerBestEffort(cid),
    shutdown: () => provider.shutdown(),
  };
}

describe('enablePointerWinBroadcasts — default-OFF policy (#264)', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('default (no config): winBroadcastsEnabled() returns false; storage:pointer-published fires WITHOUT signedPayloadJson/broadcastTag (PR #316 F2)', async () => {
    // PR #316 F2: the event is now emitted UNCONDITIONALLY on a
    // successful publish so consumers (e.g. resetEpoch's publish
    // await) can observe the landing. The win-broadcast gate now
    // controls only the signedPayloadJson / broadcastTag fields,
    // NOT the event itself.
    const pointer = await buildRealPointerWithFlag(undefined);
    expect(pointer.winBroadcastsEnabled()).toBe(false);

    const h = await createHarness(pointer);
    const result = await h.publish(FAKE_CID);
    expect(result.ok).toBe(true);

    const published = h.events.find((e) => e.type === 'storage:pointer-published');
    expect(published).toBeDefined();
    const data = published!.data as {
      cid?: string;
      version?: number;
      signedPayloadJson?: string;
      broadcastTag?: string;
    };
    expect(data.cid).toBe(FAKE_CID);
    expect(data.version).toBe(11);
    // Win-broadcast fields are suppressed because the flag is OFF.
    expect(data.signedPayloadJson).toBeUndefined();
    expect(data.broadcastTag).toBeUndefined();

    await h.shutdown();
  });

  it('explicit false: same shape as default (event emitted, no broadcast fields)', async () => {
    const pointer = await buildRealPointerWithFlag(false);
    expect(pointer.winBroadcastsEnabled()).toBe(false);

    const h = await createHarness(pointer);
    const result = await h.publish(FAKE_CID);
    expect(result.ok).toBe(true);
    const published = h.events.find((e) => e.type === 'storage:pointer-published');
    expect(published).toBeDefined();
    const data = published!.data as {
      signedPayloadJson?: string;
      broadcastTag?: string;
    };
    expect(data.signedPayloadJson).toBeUndefined();
    expect(data.broadcastTag).toBeUndefined();

    await h.shutdown();
  });

  it('explicit true: storage:pointer-published fires with signed payload + tag', async () => {
    const pointer = await buildRealPointerWithFlag(true);
    expect(pointer.winBroadcastsEnabled()).toBe(true);

    const h = await createHarness(pointer);
    const result = await h.publish(FAKE_CID);
    expect(result.ok).toBe(true);

    const published = h.events.find((e) => e.type === 'storage:pointer-published');
    expect(published).toBeDefined();
    const data = published!.data as {
      cid?: string;
      version?: number;
      signedPayloadJson?: string;
      broadcastTag?: string;
    };
    expect(data.cid).toBe(FAKE_CID);
    expect(data.version).toBe(11);
    expect(typeof data.signedPayloadJson).toBe('string');
    expect(typeof data.broadcastTag).toBe('string');

    await h.shutdown();
  });

  it('truthy non-boolean (string "true", number 1) is coerced to false — strict === true policy (PR #316 F2: event emits but without broadcast fields)', async () => {
    // Pass `'true'` as a string and `1` as a number — both are truthy
    // but should fail closed per the normalization in ProfilePointerLayer's
    // frozen config snapshot (defense against accidentally truthy values
    // from env-var unmarshalling, JSON parsing, etc.).
    //
    // PR #316 F2: the gate still trips the broadcast fields off, but
    // the event itself fires unconditionally.
    for (const accidental of ['true' as unknown as boolean, 1 as unknown as boolean]) {
      const pointer = await buildRealPointerWithFlag(accidental);
      expect(pointer.winBroadcastsEnabled()).toBe(false);
      const h = await createHarness(pointer);
      const result = await h.publish(FAKE_CID);
      expect(result.ok).toBe(true);
      const published = h.events.find((e) => e.type === 'storage:pointer-published');
      expect(published).toBeDefined();
      const data = published!.data as {
        signedPayloadJson?: string;
        broadcastTag?: string;
      };
      expect(data.signedPayloadJson).toBeUndefined();
      expect(data.broadcastTag).toBeUndefined();
      await h.shutdown();
    }
  });
});
