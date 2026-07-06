/**
 * Tests for the **in-place monotonicity recovery** introduced for issue
 * #255 (post-PR #261).
 *
 * # The bug
 *
 * Before this fix, when the flush-scheduler bundle-set check detected an
 * unknown bundle CID in OrbitDB (a cross-device sync race: another
 * device's bundle landed AFTER our `lastLoadedFromBundleCids` snapshot),
 * it threw `POINTER_MONOTONICITY_VIOLATION`. Recovery relied on either:
 *
 *   (a) `awaitNextFlush`'s one-shot in-loop Gap 4 retry, which calls
 *       `refreshBaselineForMonotonicity` to repair the baseline +
 *       re-attempt the flush, or
 *   (b) a fire-and-forget `queueMicrotask` baseline refresh kicked off
 *       from the catch arm.
 *
 * Both paths only updated `lastLoadedFromBundleCids` — they did NOT pull
 * the foreign bundle's CONTENT into the in-flight CAR. Under
 * cross-device replication churn the retry race window between "refresh
 * baseline" and "next flush reads listActiveBundles" lets ANOTHER unknown
 * CID land, and the second flush re-throws the same violation. Worst
 * case: every flush in a sequence fails, the at-least-once gate refuses
 * every Nostr ack, and incoming events replay forever without ever
 * durably landing. Observed in production as the Stage B.1 v8 failure on
 * issue #255 (peer1 + peer2 each writing to the shared OrbitDB).
 *
 * # The fix (option #3 from the diagnosis)
 *
 * When the bundle-set check finds an unknown CID, the flush body now
 * fetches the foreign bundle's CAR via `fetchCarFromIpfs`, calls
 * `UxfPackage.merge()` to pull its tokens into the in-flight `pkg`,
 * re-extracts the token map + bundle ref count, and re-exports
 * `carBytes` from the merged package. The pin step then writes a CAR
 * that IS, by construction, a superset of every OrbitDB-active bundle —
 * satisfying the monotonicity invariant inline, with no retry race
 * window.
 *
 * Fallback: if the inline fetch+merge fails (network down, malformed
 * CAR, etc.), the bundle stays in `unknownBundleCids` and the legacy
 * violation throw fires, preserving the old safety net (Gap 4 retry +
 * fire-and-forget refresh).
 *
 * # What these tests cover
 *
 *   - **Success path**: foreign bundle's CAR is fetchable → in-flight
 *     pkg is merged → carBytes re-export reflects merged tokens →
 *     bundle ref written with the merged tokenCount → NO violation
 *     emitted → pin succeeds → baseline updated.
 *   - **Fallback path**: fetch returns 404 → violation still throws →
 *     legacy Gap 4 / fire-and-forget refresh path applies (this is
 *     already covered by the pre-existing race-stale-flush test in
 *     `pointer-monotonicity.test.ts`, so we just sanity-check the
 *     fallback fires here without re-asserting the legacy semantics).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type {
  ProfileDatabase,
  OrbitDbConfig,
  UxfBundleRef,
} from '../../../profile/types';
import type { FullIdentity } from '../../../types';
import type { TxfStorageDataBase } from '../../../storage/storage-provider';
import { ProfileTokenStorageProvider } from '../../../profile/profile-token-storage-provider';
import {
  deriveProfileEncryptionKey,
  encryptProfileValue,
} from '../../../profile/encryption';
import { POINTER_MONOTONICITY_VIOLATION } from '../../../profile/profile-token-storage/flush-scheduler';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const EXPECTED_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  directAddress: 'DIRECT://AABBCCDDEEFF112233445566778899AABBCCDDEEFF',
  privateKey: TEST_PRIVATE_KEY,
};
const BUNDLE_KEY_PREFIX = 'tokens.bundle.';

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function getEncryptionKey(): Uint8Array {
  return deriveProfileEncryptionKey(hexToBytes(TEST_PRIVATE_KEY));
}

function buildTxfData(
  tokens: Record<string, unknown> = {},
): TxfStorageDataBase {
  return {
    _meta: {
      version: 1,
      address: EXPECTED_ADDRESS_ID,
      formatVersion: '1.0.0',
      updatedAt: 1_700_000_000_000,
    },
    ...tokens,
  };
}

// ---------------------------------------------------------------------------
// Mock UxfPackage — same shape used by `pointer-monotonicity.test.ts`.
//
// Tokens are tracked as an array; merge concatenates `_tokens`. toCar
// returns a fake CAR (JSON-shaped payload wrapped in a real CAR envelope
// via the shared `_helpers/fake-uxf-car.js`). The flush-scheduler calls
// `extractCarRootCid(carBytes)` + `pinCarBlocksToIpfs(...)` on the real
// CAR-derived CID, so the fake-CAR helper preserves that contract.
// ---------------------------------------------------------------------------

vi.mock('../../../uxf/UxfPackage.js', async () => {
  const { makeFakeUxfCar, decodeFakeUxfCar } = await import(
    './_helpers/fake-uxf-car.js'
  );

  function makePkg(): {
    _tokens: unknown[];
    ingestAll(tokens: unknown[]): void;
    merge(other: { _tokens?: unknown[] }): void;
    assembleAll(): Map<string, unknown>;
    toCar(): Promise<Uint8Array>;
  } {
    const tokens: unknown[] = [];
    return {
      _tokens: tokens,
      ingestAll(items: unknown[]) {
        for (const t of items) tokens.push(t);
      },
      merge(other: { _tokens?: unknown[] }) {
        if (other._tokens) for (const t of other._tokens) tokens.push(t);
      },
      assembleAll() {
        const result = new Map<string, unknown>();
        for (let i = 0; i < tokens.length; i++) {
          const t = tokens[i] as Record<string, unknown>;
          result.set((t.id as string) ?? `_t${i}`, t);
        }
        return result;
      },
      async toCar() {
        const sorted = [...tokens].sort((a, b) => {
          const aid = ((a as Record<string, unknown>).id as string) ?? '';
          const bid = ((b as Record<string, unknown>).id as string) ?? '';
          return aid.localeCompare(bid);
        });
        return makeFakeUxfCar({ tokens: sorted });
      },
    };
  }

  return {
    UxfPackage: {
      create() {
        return makePkg();
      },
      async fromCar(carBytes: Uint8Array) {
        let parsed: { tokens?: unknown[] };
        try {
          parsed = await decodeFakeUxfCar<{ tokens?: unknown[] }>(carBytes);
        } catch {
          const text = new TextDecoder().decode(carBytes);
          parsed = JSON.parse(text) as { tokens?: unknown[] };
        }
        const pkg = makePkg();
        pkg.ingestAll(parsed.tokens ?? []);
        return pkg;
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Mock the bundle CAR fetcher. The inline recovery calls
// `fetchCarFromIpfs` from `profile/ipfs-client.ts` to pull the foreign
// bundle's bytes; we stub it module-wide so the test controls exactly
// which CIDs resolve.
// ---------------------------------------------------------------------------

const fetchByCid = new Map<string, Uint8Array>();
let fetchCalls = 0;
let lastFetchedCid: string | null = null;

vi.mock('../../../profile/ipfs-client.js', async () => {
  const actual = await vi.importActual<typeof import('../../../profile/ipfs-client.js')>(
    '../../../profile/ipfs-client.js',
  );
  return {
    ...actual,
    fetchCarFromIpfs: vi.fn(async (_gateways: string[], cid: string) => {
      fetchCalls++;
      lastFetchedCid = cid;
      const bytes = fetchByCid.get(cid);
      if (!bytes) throw new Error(`fetchCarFromIpfs stub: no bytes for ${cid}`);
      return bytes;
    }),
    pinCarBlocksToIpfs: vi.fn(async (_gws: string[], _carBytes: Uint8Array, expectedRootCid: string) => {
      // Echo back the expected root CID — the flush-scheduler treats this
      // as the authoritative CID for the bundle ref it then writes to
      // OrbitDB.
      return expectedRootCid;
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock ProfileDatabase
// ---------------------------------------------------------------------------

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  let connected = true;
  return {
    _store: store,
    async connect(_config: OrbitDbConfig) {
      connected = true;
    },
    async put(key: string, value: Uint8Array) {
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async del(key: string) {
      store.delete(key);
    },
    async all(prefix?: string) {
      const out = new Map<string, Uint8Array>();
      for (const [k, v] of store) if (!prefix || k.startsWith(prefix)) out.set(k, v);
      return out;
    },
    async close() {
      connected = false;
    },
    onReplication() {
      return () => {};
    },
    isConnected() {
      return connected;
    },
  } as MockProfileDb;
}

async function plantBundleInOrbit(
  db: MockProfileDb,
  cid: string,
  ref: UxfBundleRef,
): Promise<void> {
  const encKey = getEncryptionKey();
  db._store.set(
    `${BUNDLE_KEY_PREFIX}${cid}`,
    await encryptProfileValue(
      encKey,
      new TextEncoder().encode(JSON.stringify(ref)),
    ),
  );
}

function createProvider(db: MockProfileDb): ProfileTokenStorageProvider {
  const provider = new ProfileTokenStorageProvider(
    db,
    getEncryptionKey(),
    ['https://mock-ipfs.test'],
    {
      config: {
        orbitDb: { privateKey: TEST_PRIVATE_KEY },
        ipnsSnapshot: false,
      },
      addressId: EXPECTED_ADDRESS_ID,
      encrypt: true,
      flushDebounceMs: 30,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FlushScheduler — in-place monotonicity recovery (#255)', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
    fetchByCid.clear();
    fetchCalls = 0;
    lastFetchedCid = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('on unknown bundle whose CAR is fetchable, merges it inline and pins WITHOUT throwing the violation', async () => {
    const provider = createProvider(db);
    await provider.initialize();

    // Seed our baseline as if a prior load() merged a known bundle B_local.
    // Use the SAME fake-CAR helper the mocked UxfPackage uses so the
    // CID we plant matches what `pkg.toCar()` would produce.
    const { makeFakeUxfCar } = await import('./_helpers/fake-uxf-car.js');
    const { extractCarRootCid } = await import('../../../uxf/transfer-payload.js');

    const tokenLocal = { id: '_TL', genesis: { tokenId: 'TL' } };
    const localCarBytes = await makeFakeUxfCar({ tokens: [tokenLocal] });
    const localCid = await extractCarRootCid(localCarBytes);

    (provider as unknown as {
      lastLoadedData: TxfStorageDataBase;
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedData = buildTxfData({ _TL: tokenLocal });
    (provider as unknown as {
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedFromBundleCids = new Set([localCid]);

    // A foreign bundle B_remote landed in OrbitDB AFTER our snapshot.
    const tokenRemote = { id: '_TR', genesis: { tokenId: 'TR' } };
    const remoteCarBytes = await makeFakeUxfCar({ tokens: [tokenRemote] });
    const remoteCid = await extractCarRootCid(remoteCarBytes);
    await plantBundleInOrbit(db, remoteCid, {
      cid: remoteCid,
      status: 'active',
      createdAt: 1000,
    });

    // Wire the stub: the inline recovery will fetch B_remote's CAR.
    fetchByCid.set(remoteCid, remoteCarBytes);

    // The save() carries our own local-mutation data (still based on
    // pre-remote state). Without inline recovery, the bundle-set check
    // would throw violation; with the fix, the recovery merges and pins.
    const pendingData = buildTxfData({ _TL: tokenLocal });
    (provider as unknown as { pendingData: TxfStorageDataBase }).pendingData =
      pendingData;

    const violationEvents: Array<{ code?: string; data?: unknown }> = [];
    provider.onEvent((evt) => {
      if (evt.type === 'storage:error' && evt.code === POINTER_MONOTONICITY_VIOLATION) {
        violationEvents.push({ code: evt.code, data: evt.data });
      }
    });

    // Drive the flush directly via the internal scheduler.
    const flushScheduler = (
      provider as unknown as {
        flushScheduler: { flushToIpfs(): Promise<void> };
      }
    ).flushScheduler;

    await flushScheduler.flushToIpfs();

    // Inline merge happened: fetchCarFromIpfs was called for the remote CID.
    expect(fetchCalls).toBe(1);
    expect(lastFetchedCid).toBe(remoteCid);

    // No violation event was emitted (the inline merge satisfied the
    // invariant before the throw path fired).
    expect(violationEvents).toHaveLength(0);

    // The baseline now includes the remote CID — subsequent flushes
    // pass the bundle-set check trivially.
    const baseline = (provider as unknown as {
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedFromBundleCids;
    expect(baseline.has(remoteCid)).toBe(true);

    // A new bundle ref was written to OrbitDB representing the merged CAR.
    const bundleKeys = [...db._store.keys()].filter((k) =>
      k.startsWith(BUNDLE_KEY_PREFIX),
    );
    // 2 = the planted remote + our just-merged superset
    expect(bundleKeys.length).toBeGreaterThanOrEqual(2);

    await provider.shutdown();
  });

  it('on unknown bundle whose fetch FAILS, auto-merge surfaces the residual via events but flush continues (#264)', async () => {
    // Issue #264 — the legacy throw is replaced by an auto-merge that
    // logs warn-level and proceeds. The unfetchable CID is reported on
    // BOTH `storage:monotonicity-recovered` (as a residual) AND on
    // legacy `storage:error` with POINTER_MONOTONICITY_VIOLATION (so
    // dashboards keyed on the literal still fire), but NO throw escapes
    // the flush body.
    const provider = createProvider(db);
    await provider.initialize();

    const { makeFakeUxfCar } = await import('./_helpers/fake-uxf-car.js');
    const { extractCarRootCid } = await import('../../../uxf/transfer-payload.js');

    const tokenLocal = { id: '_TL', genesis: { tokenId: 'TL' } };
    const localCarBytes = await makeFakeUxfCar({ tokens: [tokenLocal] });
    const localCid = await extractCarRootCid(localCarBytes);

    (provider as unknown as {
      lastLoadedData: TxfStorageDataBase;
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedData = buildTxfData({ _TL: tokenLocal });
    (provider as unknown as {
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedFromBundleCids = new Set([localCid]);

    // The foreign bundle is in OrbitDB but its CAR is NOT in fetchByCid
    // → the stub throws → inline merge fails → residual after auto-merge.
    const tokenRemote = { id: '_TR', genesis: { tokenId: 'TR' } };
    const remoteCarBytes = await makeFakeUxfCar({ tokens: [tokenRemote] });
    const remoteCid = await extractCarRootCid(remoteCarBytes);
    await plantBundleInOrbit(db, remoteCid, {
      cid: remoteCid,
      status: 'active',
      createdAt: 1000,
    });
    // Intentionally do NOT register remoteCid in fetchByCid.

    const pendingData = buildTxfData({ _TL: tokenLocal });
    (provider as unknown as { pendingData: TxfStorageDataBase }).pendingData =
      pendingData;

    const violationEvents: Array<{ code?: string; data?: unknown }> = [];
    const recoveredEvents: Array<{ data?: unknown }> = [];
    provider.onEvent((evt) => {
      if (evt.type === 'storage:error' && evt.code === POINTER_MONOTONICITY_VIOLATION) {
        violationEvents.push({ code: evt.code, data: evt.data });
      } else if (evt.type === 'storage:monotonicity-recovered') {
        recoveredEvents.push({ data: evt.data });
      }
    });

    const flushScheduler = (
      provider as unknown as {
        flushScheduler: { flushToIpfs(): Promise<void> };
      }
    ).flushScheduler;

    let thrown: unknown = null;
    try {
      await flushScheduler.flushToIpfs();
    } catch (err) {
      thrown = err;
    }

    // Issue #264 — no throw escapes the flush body.
    expect(thrown).toBeNull();
    expect(fetchCalls).toBe(1); // we tried the inline fetch

    // The recovered event surfaces the residual unknown bundle.
    expect(recoveredEvents.length).toBe(1);
    const recoveredData = recoveredEvents[0]!.data as {
      mergedUnknownBundleCount: number;
      residualUnknownBundleCids: string[];
      residualUnknownBundleCount: number;
      recoveredTokenCount: number;
    };
    expect(recoveredData.mergedUnknownBundleCount).toBe(0);
    expect(recoveredData.residualUnknownBundleCount).toBe(1);
    expect(recoveredData.residualUnknownBundleCids).toContain(remoteCid);
    expect(recoveredData.recoveredTokenCount).toBe(0);

    // The legacy storage:error event also fires for dashboards,
    // discriminated by `autoMergeResidual: true`. The pre-#264
    // `alert: 'transfer:operator-alert'` field is INTENTIONALLY no
    // longer emitted — see the residual-emit comment in
    // flush-scheduler.ts for the on-call burnout rationale.
    expect(violationEvents.length).toBeGreaterThan(0);
    const alert = violationEvents.find(
      (e) => (e.data as { autoMergeResidual?: boolean } | undefined)?.autoMergeResidual === true,
    );
    expect(alert).toBeDefined();
    const data = alert!.data as {
      unknownBundleCids: string[];
      unknownBundleCount: number;
      autoMergeResidual?: boolean;
      alert?: string;
    };
    expect(data.unknownBundleCount).toBe(1);
    expect(data.unknownBundleCids).toContain(remoteCid);
    expect(data.autoMergeResidual).toBe(true);
    expect(data.alert).toBeUndefined();

    await provider.shutdown();
  });

  it('when multiple unknown bundles are present, all fetchable ones are merged; only fetch-failed ones surface as residual (#264)', async () => {
    const provider = createProvider(db);
    await provider.initialize();

    const { makeFakeUxfCar } = await import('./_helpers/fake-uxf-car.js');
    const { extractCarRootCid } = await import('../../../uxf/transfer-payload.js');

    const tokenLocal = { id: '_TL', genesis: { tokenId: 'TL' } };
    const localCarBytes = await makeFakeUxfCar({ tokens: [tokenLocal] });
    const localCid = await extractCarRootCid(localCarBytes);

    (provider as unknown as {
      lastLoadedData: TxfStorageDataBase;
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedData = buildTxfData({ _TL: tokenLocal });
    (provider as unknown as {
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedFromBundleCids = new Set([localCid]);

    // Two foreign bundles. Only the first is fetchable.
    const tokenA = { id: '_TA', genesis: { tokenId: 'TA' } };
    const carA = await makeFakeUxfCar({ tokens: [tokenA] });
    const cidA = await extractCarRootCid(carA);
    await plantBundleInOrbit(db, cidA, { cid: cidA, status: 'active', createdAt: 1000 });
    fetchByCid.set(cidA, carA);

    const tokenB = { id: '_TB', genesis: { tokenId: 'TB' } };
    const carB = await makeFakeUxfCar({ tokens: [tokenB] });
    const cidB = await extractCarRootCid(carB);
    await plantBundleInOrbit(db, cidB, { cid: cidB, status: 'active', createdAt: 1001 });
    // cidB NOT in fetchByCid — its fetch will throw.

    const pendingData = buildTxfData({ _TL: tokenLocal });
    (provider as unknown as { pendingData: TxfStorageDataBase }).pendingData =
      pendingData;

    const violationEvents: Array<{ code?: string; data?: unknown }> = [];
    provider.onEvent((evt) => {
      if (evt.type === 'storage:error' && evt.code === POINTER_MONOTONICITY_VIOLATION) {
        violationEvents.push({ code: evt.code, data: evt.data });
      }
    });

    const flushScheduler = (
      provider as unknown as {
        flushScheduler: { flushToIpfs(): Promise<void> };
      }
    ).flushScheduler;

    let thrown: unknown = null;
    try {
      await flushScheduler.flushToIpfs();
    } catch (err) {
      thrown = err;
    }

    // Both fetches were attempted.
    expect(fetchCalls).toBe(2);
    // Issue #264 — no throw escapes; flush continues with the
    // best-effort superset including cidA's tokens.
    expect(thrown).toBeNull();

    // cidA WAS added to the baseline (the inline merge succeeded for it).
    // cidB stays OUT of the baseline so the NEXT flush re-evaluates the
    // bundle-set check and re-attempts the inline fetch (per #264 the
    // legacy refreshBaselineForMonotonicity microtask was intentionally
    // removed; a refresh would have marked cidB as "in baseline" and
    // silently skipped the residual retry on subsequent flushes).
    const baseline = (provider as unknown as {
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedFromBundleCids;
    expect(baseline.has(cidA)).toBe(true);
    expect(baseline.has(cidB)).toBe(false);

    // The legacy storage:error payload (kept for dashboards keyed on
    // the literal POINTER_MONOTONICITY_VIOLATION) mentions ONLY cidB.
    // Discriminated by `autoMergeResidual: true`; the pre-#264
    // `alert: 'transfer:operator-alert'` field is no longer set.
    const alert = violationEvents.find(
      (e) => (e.data as { autoMergeResidual?: boolean } | undefined)?.autoMergeResidual === true,
    );
    expect(alert).toBeDefined();
    const data = alert!.data as {
      unknownBundleCids: string[];
      unknownBundleCount: number;
      autoMergeResidual?: boolean;
      alert?: string;
    };
    expect(data.unknownBundleCount).toBe(1);
    expect(data.unknownBundleCids).toContain(cidB);
    expect(data.unknownBundleCids).not.toContain(cidA);
    expect(data.autoMergeResidual).toBe(true);
    expect(data.alert).toBeUndefined();

    await provider.shutdown();
  });
});
