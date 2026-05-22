/**
 * Regression tests for the pointer monotonicity invariant.
 *
 * # The invariant
 *
 * Every published pointer V_n MUST reference a profile state that is a
 * SUPERSET of every previously-published pointer V_n-1, V_n-2, ...
 * Concretely:
 *
 *   - The CAR pinned for V_n MUST contain at least every token reachable
 *     from V_n-1's reachable bundles.
 *   - The OrbitDB bundle index MUST list every bundle CID that was
 *     reachable from V_n-1.
 *
 * Violation = silent token loss across cross-device sync. Critical.
 *
 * # Failure modes covered
 *
 * - **Mode A — Fix-2 no-data flush race**: handleReplication discovers
 *   a remote bundle, fires `storage:remote-updated` (which schedules a
 *   debounced PaymentsModule.sync → load → lastLoadedData merge), AND
 *   schedules a no-data flush. If the flush timer fires BEFORE load
 *   completes, the flush body reads STALE lastLoadedData and pins a CAR
 *   without the new remote bundle's tokens. The fix awaits load() before
 *   scheduling the no-data flush, so lastLoadedData is by-construction a
 *   superset of every active bundle when the flush runs.
 *
 * - **Mode B — Runtime invariant assertion**: defense-in-depth. Even if
 *   Mode A's await is bypassed (race window, custom replication code,
 *   future regression), the flushToIpfs body verifies that the new CAR's
 *   tokens ⊇ lastLoadedData's tokens AND no unknown bundles appeared in
 *   OrbitDB since the last load. A violation aborts pin + publish and
 *   emits POINTER_MONOTONICITY_VIOLATION via storage:error.
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
import { sha256 } from '@noble/hashes/sha2.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { create as createDigest } from 'multiformats/hashes/digest';

// =============================================================================
// Test fixtures
// =============================================================================

const TEST_PRIVATE_KEY =
  'aabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccddaabbccdd';
const EXPECTED_ADDRESS_ID = 'DIRECT_aabbcc_ddeeff';
const TEST_IDENTITY: FullIdentity = {
  chainPubkey: '02' + 'aa'.repeat(32),
  l1Address: 'alpha1testaddress',
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

function cidForBytes(bytes: Uint8Array): string {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest).toString();
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

// =============================================================================
// Mock ProfileDatabase
// =============================================================================

interface MockProfileDb extends ProfileDatabase {
  _store: Map<string, Uint8Array>;
  _triggerReplication(): void;
  _listeners: Array<() => void>;
}

function createMockDb(): MockProfileDb {
  const store = new Map<string, Uint8Array>();
  const listeners: Array<() => void> = [];
  let connected = true;
  return {
    _store: store,
    _listeners: listeners,
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
    onReplication(cb: () => void) {
      listeners.push(cb);
      return () => {
        const i = listeners.indexOf(cb);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    isConnected() {
      return connected;
    },
    _triggerReplication() {
      listeners.forEach((cb) => cb());
    },
  } as MockProfileDb;
}

// =============================================================================
// UxfPackage mock — produces deterministic, content-addressable bytes
// =============================================================================

vi.mock('../../../uxf/UxfPackage.js', async () => {
  // Issue #200 Phase 2: `toCar()` must return a real CAR (not JSON bytes)
  // because the flush scheduler now calls `extractCarRootCid` +
  // `pinCarBlocksToIpfs`. `makeFakeUxfCar` wraps the JSON-shaped
  // payload inside a minimal valid CAR; `decodeFakeUxfCar` recovers it.
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
        // Deterministic order: sort by id so the CID is stable across
        // ingest order.
        const sorted = [...tokens].sort((a, b) => {
          const aid = (a as Record<string, unknown>).id as string ?? '';
          const bid = (b as Record<string, unknown>).id as string ?? '';
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
        // Dual-shape decode: prefer the new fake-CAR shape; fall back to
        // raw JSON so legacy pre-built fixture bytes still resolve.
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

// =============================================================================
// Mock fetch — captures pin + fetch traffic
// =============================================================================

interface FetchTracker {
  pinCalls: number;
  fetched: Map<string, Uint8Array>;
}

const originalFetch = globalThis.fetch;

function installMockFetch(
  tracker: FetchTracker,
  carBytesByCid: Map<string, Uint8Array>,
): void {
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    if (url.includes('/api/v0/dag/put') || url.includes('/api/v0/block/put')) {
      tracker.pinCalls++;
      return new Response(JSON.stringify({ Cid: { '/': 'gateway-cid' } }), {
        status: 200,
      });
    }

    // /api/v0/block/get?arg=<cid>  OR /ipfs/<cid>
    const blockGetMatch = url.match(/\/api\/v0\/block\/get\?arg=([^&]+)/);
    const ipfsMatch = url.match(/\/ipfs\/([^/?]+)/);
    const cid = blockGetMatch
      ? decodeURIComponent(blockGetMatch[1]!)
      : ipfsMatch
        ? ipfsMatch[1]
        : null;
    if (cid) {
      const bytes = carBytesByCid.get(cid);
      if (bytes) {
        tracker.fetched.set(cid, bytes);
        return new Response(bytes, { status: 200 });
      }
    }
    return new Response('', { status: 404 });
  }) as typeof fetch;
}

function uninstallMockFetch(): void {
  globalThis.fetch = originalFetch;
}

// =============================================================================
// Provider factory
// =============================================================================

function createProvider(
  db: MockProfileDb,
  opts?: { flushDebounceMs?: number },
): ProfileTokenStorageProvider {
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
      flushDebounceMs: opts?.flushDebounceMs ?? 30,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
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

/**
 * Issue #215: wait for any debounced flush armed via `scheduleFlush*`
 * to actually fire AND its in-flight promise to settle.
 *
 * The bare `setTimeout(r, flushDebounceMs + epsilon)` pattern is racy
 * under full-suite worker contention: the debounce timer may not have
 * fired yet at the wake-up, and the flush body's awaits (mocked
 * `fetch`, dynamic `import('UxfPackage.js')`) take real time. If the
 * test asserts before the flush settles, leaked in-flight work bumps
 * the shared `tracker.pinCalls` counter mid-way through the NEXT test
 * (which has already swapped in its own tracker via `installMockFetch`),
 * making that test fail with `pinCalls = 1` when it expected 0.
 *
 * Strategy: poll until the host exposes a non-null `flushPromise` (the
 * timer fired and a flush is now in flight), then `await` it. If no
 * flush starts within the deadline, return — the caller is then free
 * to assert "nothing happened" without worrying about a deferred pin.
 */
async function waitForFlushSettled(
  provider: ProfileTokenStorageProvider,
  deadlineMs = 2000,
): Promise<void> {
  const host = provider as unknown as {
    flushPromise: Promise<void> | null;
    flushTimer: ReturnType<typeof setTimeout> | null;
  };
  const start = Date.now();
  // Wait for the debounce timer to fire (flushPromise becomes non-null)
  // OR for both the timer and the promise to be null AND stay null for
  // a short stability window (= no flush was actually scheduled).
  while (Date.now() - start < deadlineMs) {
    if (host.flushPromise) {
      try {
        await host.flushPromise;
      } catch {
        // Flush body throws on POINTER_MONOTONICITY_VIOLATION etc.;
        // that's a normal completion path for the tests below.
      }
      // After settle, check whether a chained flush re-armed.
      if (!host.flushTimer && !host.flushPromise) return;
      continue;
    }
    if (!host.flushTimer) {
      // Stability window — give a late-arming timer a moment to land.
      await new Promise((r) => setTimeout(r, 5));
      if (!host.flushTimer && !host.flushPromise) return;
      continue;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('pointer monotonicity invariant', () => {
  let db: MockProfileDb;
  let tracker: FetchTracker;

  beforeEach(() => {
    db = createMockDb();
    tracker = { pinCalls: 0, fetched: new Map() };
  });

  afterEach(() => {
    uninstallMockFetch();
  });

  // ---------------------------------------------------------------------------
  // Test 1: Happy path — V2 ⊃ V1 (superset) → assertion passes
  // ---------------------------------------------------------------------------
  it('happy path: V2 published with tokens {T1, T2} after V1 with {T1} — assertion passes', async () => {
    installMockFetch(tracker, new Map());
    const provider = createProvider(db, { flushDebounceMs: 20 });
    await provider.initialize();

    // V1: save() with {T1}
    const tokenT1 = { id: '_T1', genesis: { tokenId: 'T1' } };
    const v1 = buildTxfData({ _T1: tokenT1 });
    await provider.save(v1);

    // Issue #215: wait for the debounced V1 flush to actually finish
    // pinning. The original `setTimeout(r, 80)` expired before the
    // pin under full-suite contention (load() + import('UxfPackage.js')
    // round-trip), the assertion failed mid-test, AND the in-flight
    // flush later bumped `tracker.pinCalls` while the NEXT test was
    // running (cascading into "race-stale flush" failing with
    // pinCalls=1 vs expected 0).
    await vi.waitFor(() => {
      expect(tracker.pinCalls).toBe(1);
    }, { timeout: 5000, interval: 25 });

    // V2: save() with {T1, T2} — strict superset.
    const tokenT2 = { id: '_T2', genesis: { tokenId: 'T2' } };
    const v2 = buildTxfData({ _T1: tokenT1, _T2: tokenT2 });
    await provider.save(v2);

    await vi.waitFor(() => {
      expect(tracker.pinCalls).toBe(2);
    }, { timeout: 5000, interval: 25 });

    // Both bundles registered in OrbitDB.
    const bundleKeys = [...db._store.keys()].filter((k) =>
      k.startsWith(BUNDLE_KEY_PREFIX),
    );
    expect(bundleKeys.length).toBe(2);

    await provider.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Test 2: Race-stale flush (Mode A scenario) — assertion fires
  // ---------------------------------------------------------------------------
  it('race-stale flush: lastLoadedData missing tokens that are in active OrbitDB bundles → assertion fires, no publish', async () => {
    // Simulate the Mode A race: an active bundle B_remote (containing
    // T_remote) lives in OrbitDB but lastLoadedData was captured BEFORE
    // it replicated. A no-data flush built from stale lastLoadedData
    // would produce a CAR missing T_remote — silent token loss.
    //
    // The bundle-set check fires: B_remote's CID is in the active
    // bundle index but NOT in lastLoadedFromBundleCids.
    installMockFetch(tracker, new Map());
    const provider = createProvider(db, { flushDebounceMs: 20 });
    await provider.initialize();

    // Plant the device's prior state: load() merged a single bundle
    // B_local containing T_local. We simulate this by directly setting
    // the bookkeeping — load() itself is not the unit under test here.
    const tokenLocal = { id: '_TL', genesis: { tokenId: 'TL' } };
    const localData = buildTxfData({ _TL: tokenLocal });
    const localCarBytes = new TextEncoder().encode(
      JSON.stringify({ tokens: [tokenLocal] }),
    );
    const localCid = cidForBytes(localCarBytes);

    (provider as unknown as {
      lastLoadedData: TxfStorageDataBase;
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedData = localData;
    (provider as unknown as {
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedFromBundleCids = new Set([localCid]);

    // Inject the remote bundle into OrbitDB AFTER the snapshot — this
    // is the stale-baseline scenario.
    const tokenRemote = { id: '_TR', genesis: { tokenId: 'TR' } };
    const remoteCarBytes = new TextEncoder().encode(
      JSON.stringify({ tokens: [tokenRemote] }),
    );
    const remoteCid = cidForBytes(remoteCarBytes);
    await plantBundleInOrbit(db, remoteCid, {
      cid: remoteCid,
      status: 'active',
      createdAt: 1000,
    });

    // Listen for storage:error events to verify the assertion fires.
    const errors: Array<{ code?: string; data?: unknown }> = [];
    provider.onEvent((evt) => {
      if (evt.type === 'storage:error' && evt.code === POINTER_MONOTONICITY_VIOLATION) {
        errors.push({ code: evt.code, data: evt.data });
      }
    });

    // Trigger a no-data flush WITHOUT first running load(). The flush
    // body sources from lastLoadedData (stale) and the bundle-set check
    // detects the unknown remote bundle.
    const flushScheduler = (
      provider as unknown as {
        flushScheduler: { scheduleFlushNoData: () => void };
      }
    ).flushScheduler;
    flushScheduler.scheduleFlushNoData();

    // Issue #215: wait for the debounced flush to actually run
    // (timer → flush body → catch arm) before asserting that no pin
    // was issued. The original 100 ms fixed wait was insufficient
    // under full-suite contention.
    await waitForFlushSettled(provider);

    // Assertion fired: no pin, error event emitted with the violation
    // code and the unknown bundle CID listed.
    expect(tracker.pinCalls).toBe(0);
    expect(errors.length).toBeGreaterThan(0);
    const alertEvent = errors.find(
      (e) => (e.data as { alert?: string } | undefined)?.alert === 'transfer:operator-alert',
    );
    expect(alertEvent).toBeDefined();
    const alertData = alertEvent!.data as {
      unknownBundleCids: string[];
      unknownBundleCount: number;
    };
    expect(alertData.unknownBundleCount).toBe(1);
    expect(alertData.unknownBundleCids).toContain(remoteCid);

    await provider.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Test 3: Direct token-loss attempt — assertion fires
  // ---------------------------------------------------------------------------
  it('token-loss: flush data missing a token from lastLoadedData baseline → assertion fires, no publish', async () => {
    // Construct a flush where `data` (set via save()) is missing a
    // token present in lastLoadedData. The token-set check fires.
    installMockFetch(tracker, new Map());
    const provider = createProvider(db, { flushDebounceMs: 20 });
    await provider.initialize();

    const tokenA = { id: '_TA', genesis: { tokenId: 'TA' } };
    const tokenB = { id: '_TB', genesis: { tokenId: 'TB' } };

    // Plant the baseline: lastLoadedData has BOTH A and B (this
    // represents the state load() produced from the active bundles).
    // Don't track a corresponding bundle in OrbitDB so the bundle-set
    // check trivially passes (bundle-set check requires a non-null
    // lastLoadedFromBundleCids; we set it to an empty set so the
    // bundle-set check does fire BUT correctly observes "no unknown
    // bundles" — only the token-set check should produce the violation).
    const baseline = buildTxfData({ _TA: tokenA, _TB: tokenB });
    (provider as unknown as {
      lastLoadedData: TxfStorageDataBase;
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedData = baseline;
    (provider as unknown as {
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedFromBundleCids = new Set();

    // The about-to-flush data has only A — B is being dropped.
    const partialData = buildTxfData({ _TA: tokenA });

    // Drive the flush directly via the internal scheduler (avoids
    // save() overwriting lastLoadedData to match partialData).
    const flushScheduler = (
      provider as unknown as {
        flushScheduler: { flushToIpfs(): Promise<void> };
      }
    ).flushScheduler;
    (provider as unknown as { pendingData: TxfStorageDataBase }).pendingData =
      partialData;

    const errors: Array<{ code?: string; data?: unknown }> = [];
    provider.onEvent((evt) => {
      if (evt.type === 'storage:error' && evt.code === POINTER_MONOTONICITY_VIOLATION) {
        errors.push({ code: evt.code, data: evt.data });
      }
    });

    // The flush body throws on violation. The catch in scheduleFlush
    // would normally swallow it, but we invoke flushToIpfs() directly
    // to assert the throw, then verify the events.
    let thrown: unknown = null;
    try {
      await flushScheduler.flushToIpfs();
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expect((thrown as { code?: string }).code).toBe(POINTER_MONOTONICITY_VIOLATION);
    expect(tracker.pinCalls).toBe(0);

    expect(errors.length).toBeGreaterThan(0);
    const alertEvent = errors.find(
      (e) => (e.data as { alert?: string } | undefined)?.alert === 'transfer:operator-alert',
    );
    expect(alertEvent).toBeDefined();
    const alertData = alertEvent!.data as {
      missingTokenIds: string[];
      missingTokenCount: number;
    };
    expect(alertData.missingTokenCount).toBe(1);
    expect(alertData.missingTokenIds).toContain('_TB');

    await provider.shutdown();
  });

  // ---------------------------------------------------------------------------
  // Test 4: No-data short-circuit still works for genuine match
  // ---------------------------------------------------------------------------
  it('no-data short-circuit: merged-state CAR equals lastDiscoveredPointerCid → no publication, no assertion violation', async () => {
    installMockFetch(tracker, new Map());
    const provider = createProvider(db, { flushDebounceMs: 20 });
    await provider.initialize();

    const tokenA = { id: '_TA', genesis: { tokenId: 'TA' } };
    const merged = buildTxfData({ _TA: tokenA });
    // Issue #213 (Option C): the flush scheduler publishes the
    // dag-cbor envelope CID via `pinCarBlocksToIpfs(carBytes,
    // extractCarRootCid(carBytes))`. Mirror that projection here so
    // the short-circuit comparison fires.
    const { makeFakeUxfCar } = await import('./_helpers/fake-uxf-car.js');
    const { extractCarRootCid } = await import('../../../uxf/transfer-payload.js');
    const projectedCarBytes = await makeFakeUxfCar({ tokens: [tokenA] });
    const projectedCid = await extractCarRootCid(projectedCarBytes);

    // Plant the merged state AND the matching authoritative pointer CID.
    (provider as unknown as {
      lastLoadedData: TxfStorageDataBase;
      lastDiscoveredPointerCid: string;
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedData = merged;
    (provider as unknown as {
      lastDiscoveredPointerCid: string;
    }).lastDiscoveredPointerCid = projectedCid;
    // Also plant the projectedCid as the bundle that was loaded — so
    // the bundle-set check sees no unknowns when the active bundle
    // index is also planted with this CID.
    (provider as unknown as {
      lastLoadedFromBundleCids: Set<string>;
    }).lastLoadedFromBundleCids = new Set([projectedCid]);
    await plantBundleInOrbit(db, projectedCid, {
      cid: projectedCid,
      status: 'active',
      createdAt: 1000,
    });

    const errors: Array<{ code?: string }> = [];
    provider.onEvent((evt) => {
      if (evt.type === 'storage:error' && evt.code === POINTER_MONOTONICITY_VIOLATION) {
        errors.push({ code: evt.code });
      }
    });

    const flushScheduler = (
      provider as unknown as {
        flushScheduler: { scheduleFlushNoData: () => void };
      }
    ).flushScheduler;
    flushScheduler.scheduleFlushNoData();

    // Issue #215: wait for the flush body to actually run + short-
    // circuit before asserting nothing happened. Without this the
    // assertion could pass simply because the debounce timer hadn't
    // fired yet — and the deferred flush would then leak into the
    // next test.
    await waitForFlushSettled(provider);

    // Short-circuit fired: no pin, no assertion violation.
    expect(tracker.pinCalls).toBe(0);
    expect(errors.length).toBe(0);

    await provider.shutdown();
  });
});
