/**
 * Tests for the no-data flush mechanism that anchors our own pointer
 * at the merged-from-remote state when handleReplication detects new
 * bundles via OrbitDB pubsub.
 *
 * The gap this closes:
 *
 *   Device A receives a token + publishes pointer V1 anchoring its
 *   bundle CID. Device B observes V1 via OrbitDB pubsub and merges
 *   A's bundle into its local state. B does NOT publish a V2 pointer
 *   in the historical code, so if A goes offline a future Device C
 *   joining via the aggregator pointer sees only V1's content. If B
 *   had additional state (e.g., another token A missed), C cannot
 *   recover it via Path 2.
 *
 * Fix: when handleReplication detects new bundle CIDs, schedule a
 * no-data flush. The flush body:
 *   - sources the CAR from `lastLoadedData` (merged post-load state).
 *   - computes the projected CID locally before pinning.
 *   - short-circuits when the projected CID equals
 *     `lastDiscoveredPointerCid` (no churn — the authoritative pointer
 *     already anchors this exact bytes) or already exists in the active
 *     OrbitDB bundle index (we already pinned it).
 *
 * Coverage:
 *   - Remote update with NEW bundles → flushScheduler.scheduleFlushNoData
 *     is invoked.
 *   - Merged-state CAR matches `lastDiscoveredPointerCid` → flush
 *     short-circuits before pin + publish.
 *   - Merged-state CAR differs (B has additional bundles) → flush goes
 *     through, new pointer version published.
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

/**
 * Issue #213 Option C helper: compute the dag-cbor envelope CID that
 * the flush scheduler will publish for a given token list. After
 * issue #213, bundle pinning returned to hierarchical per-block pin
 * (`pinCarBlocksToIpfs(carBytes, expectedRootCid)`); the published
 * CID is the CAR envelope root extracted via `extractCarRootCid`,
 * which is what `projectedFlushCid` mirrors.
 *
 * `makeFakeUxfCar` produces a CAR whose root is the dag-cbor envelope
 * CID over the payload; `extractCarRootCid` reads that root from the
 * CAR header.
 */
async function projectedFlushCid(tokens: unknown[]): Promise<string> {
  const { makeFakeUxfCar } = await import('./_helpers/fake-uxf-car.js');
  const { extractCarRootCid } = await import('../../../uxf/transfer-payload.js');
  const carBytes = await makeFakeUxfCar({ tokens });
  return extractCarRootCid(carBytes);
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
  // `pinCarBlocksToIpfs`. `makeFakeUxfCar` wraps the payload in a
  // minimal valid CAR; `decodeFakeUxfCar` recovers it.
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
        // Sort token IDs to make CAR bytes deterministic regardless
        // of insertion order — this lets two devices that ingest the
        // same union produce identical CIDs.
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
        // raw JSON so legacy fixture bytes still resolve.
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
// Mock fetch for IPFS pin / fetch
// =============================================================================

let mockFetchHandler:
  | ((url: string, init?: RequestInit) => Promise<Response>)
  | null = null;
const originalFetch = globalThis.fetch;

function installMockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
) {
  mockFetchHandler = handler;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const blockGetMatch = url.match(/\/api\/v0\/block\/get\?arg=([^&]+)/);
    const normalizedUrl = blockGetMatch
      ? `${url.split('/api/v0/')[0]}/ipfs/${decodeURIComponent(blockGetMatch[1]!)}`
      : url;
    return handler(normalizedUrl, init);
  };
}

function uninstallMockFetch() {
  globalThis.fetch = originalFetch;
  mockFetchHandler = null;
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
      flushDebounceMs: opts?.flushDebounceMs ?? 50,
    },
  );
  provider.setIdentity(TEST_IDENTITY);
  return provider;
}

// =============================================================================
// Tests
// =============================================================================

describe('ProfileTokenStorageProvider — no-data flush on remote update', () => {
  let db: MockProfileDb;

  beforeEach(() => {
    db = createMockDb();
  });

  afterEach(() => {
    uninstallMockFetch();
  });

  it('handleReplication with NEW bundles → scheduleFlushNoData is called', async () => {
    const provider = createProvider(db, { flushDebounceMs: 50 });
    await provider.initialize();

    const flushScheduler = (
      provider as unknown as { flushScheduler: { scheduleFlushNoData: () => void } }
    ).flushScheduler;
    const spy = vi.spyOn(flushScheduler, 'scheduleFlushNoData');

    // Simulate a remote bundle appearing.
    const encKey = getEncryptionKey();
    const carData = new TextEncoder().encode('{"tokens":[{"id":"_remoteTok"}]}');
    const cid = cidForBytes(carData);
    const ref: UxfBundleRef = { cid, status: 'active', createdAt: 500 };
    db._store.set(
      `${BUNDLE_KEY_PREFIX}${cid}`,
      await encryptProfileValue(
        encKey,
        new TextEncoder().encode(JSON.stringify(ref)),
      ),
    );

    db._triggerReplication();
    // Issue #215: `handleReplication` is async + detached and awaits
    // `this.load()` inside, which iterates `fetchCarFromIpfs` calls per
    // active bundle. Under full-suite contention the chain can take
    // 150+ ms before `scheduleFlushNoData` is reached — the original
    // 50 ms fixed wait expired before the call landed, the assertion
    // failed, and the still-in-flight `handleReplication` leaked async
    // work into the next test. Poll via `vi.waitFor` so the test
    // tolerates contention without burning real wall time when the
    // call lands quickly (the normal case).
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    }, { timeout: 5000, interval: 25 });

    await provider.shutdown();
  });

  it('handleReplication with NO new bundles → scheduleFlushNoData NOT called', async () => {
    const provider = createProvider(db, { flushDebounceMs: 50 });
    await provider.initialize();

    const flushScheduler = (
      provider as unknown as { flushScheduler: { scheduleFlushNoData: () => void } }
    ).flushScheduler;
    const spy = vi.spyOn(flushScheduler, 'scheduleFlushNoData');

    db._triggerReplication();
    await new Promise((r) => setTimeout(r, 50));

    expect(spy).not.toHaveBeenCalled();

    await provider.shutdown();
  });

  it('no-data flush short-circuits when projected CID matches lastDiscoveredPointerCid', async () => {
    // Set up: device has lastLoadedData (some merged state) and a known
    // pointer CID equal to the CAR CID we'd produce. Trigger a no-data
    // flush; the flush body must SKIP both pin and pointer-publish.
    let pinCallCount = 0;
    installMockFetch(async (url: string) => {
      if (url.includes('/api/v0/dag/put')) {
        pinCallCount++;
        return new Response(JSON.stringify({ Cid: { '/': 'will-not-be-used' } }), {
          status: 200,
        });
      }
      return new Response('', { status: 404 });
    });

    const provider = createProvider(db, { flushDebounceMs: 20 });
    await provider.initialize();

    // Plant lastLoadedData on the facade — this is what the no-data
    // flush will source from. extractTokensFromTxfData requires a
    // `genesis` field on each token; without it the token is filtered
    // out and the CAR ends up as `{"tokens":[]}`. We include genesis
    // so the projected CID is a real merged-state anchor.
    const tokenA = { id: '_tokenA', genesis: { tokenId: 'A' } };
    const merged = buildTxfData({ _tokenA: tokenA });
    (provider as unknown as { lastLoadedData: TxfStorageDataBase }).lastLoadedData =
      merged;

    // Compute the deterministic CID the no-data flush will project for
    // this state. Issue #200 Phase 2 changed the convention to the
    // dag-cbor envelope CID; `projectedFlushCid` mirrors the new shape.
    const projectedCid = await projectedFlushCid([tokenA]);

    // Plant the projected CID as lastDiscoveredPointerCid — this
    // simulates "we already discovered this exact anchor via the
    // pointer layer" (cold-start or periodic poll).
    (
      provider as unknown as { lastDiscoveredPointerCid: string | null }
    ).lastDiscoveredPointerCid = projectedCid;

    const flushScheduler = (
      provider as unknown as { flushScheduler: { scheduleFlushNoData: () => void } }
    ).flushScheduler;
    flushScheduler.scheduleFlushNoData();

    // Wait for debounce + flush to complete.
    await new Promise((r) => setTimeout(r, 100));

    // No pin should have been issued — short-circuit fired.
    expect(pinCallCount).toBe(0);

    await provider.shutdown();
  });

  it('no-data flush short-circuits when projected CID is already an active OrbitDB bundle', async () => {
    let pinCallCount = 0;
    installMockFetch(async (url: string) => {
      if (url.includes('/api/v0/dag/put')) {
        pinCallCount++;
        return new Response(JSON.stringify({ Cid: { '/': 'unused' } }), {
          status: 200,
        });
      }
      return new Response('', { status: 404 });
    });

    const provider = createProvider(db, { flushDebounceMs: 20 });
    await provider.initialize();

    const tokenA = { id: '_tokenA', genesis: { tokenId: 'A' } };
    const merged = buildTxfData({ _tokenA: tokenA });
    (provider as unknown as { lastLoadedData: TxfStorageDataBase }).lastLoadedData =
      merged;

    // The CAR our flush will project. Issue #200 Phase 2: dag-cbor
    // envelope CID convention.
    const projectedCid = await projectedFlushCid([tokenA]);

    // Plant the same CID as an ACTIVE bundle ref in OrbitDB (the local
    // log already has it — our previous flush, or an incoming remote
    // bundle whose state we already merged).
    const encKey = getEncryptionKey();
    const ref: UxfBundleRef = {
      cid: projectedCid,
      status: 'active',
      createdAt: 1000,
    };
    db._store.set(
      `${BUNDLE_KEY_PREFIX}${projectedCid}`,
      await encryptProfileValue(
        encKey,
        new TextEncoder().encode(JSON.stringify(ref)),
      ),
    );
    // Force the in-memory knownBundleCids set to include it (initialize
    // ran before we wrote it; mirror what refreshKnownBundles would
    // have produced).
    (
      provider as unknown as { knownBundleCids: Set<string> }
    ).knownBundleCids.add(projectedCid);

    const flushScheduler = (
      provider as unknown as { flushScheduler: { scheduleFlushNoData: () => void } }
    ).flushScheduler;
    flushScheduler.scheduleFlushNoData();

    await new Promise((r) => setTimeout(r, 100));

    expect(pinCallCount).toBe(0);

    await provider.shutdown();
  });

  it('no-data flush proceeds through pin + publish when projected CID differs from known anchors', async () => {
    let pinCallCount = 0;
    installMockFetch(async (url: string) => {
      if (url.includes('/api/v0/dag/put')) {
        pinCallCount++;
        return new Response(JSON.stringify({ Cid: { '/': 'gateway-returned-cid' } }), {
          status: 200,
        });
      }
      return new Response('', { status: 404 });
    });

    const provider = createProvider(db, { flushDebounceMs: 20 });
    await provider.initialize();

    // Merged state has tokens A AND B (B was contributed by this
    // device — Device A only ever pinned A). The merged-state CAR
    // therefore projects a CID different from any known anchor.
    const tokenA = { id: '_tokenA', genesis: { tokenId: 'A' } };
    const tokenB = { id: '_tokenB', genesis: { tokenId: 'B' } };
    const merged = buildTxfData({
      _tokenA: tokenA,
      _tokenB: tokenB,
    });
    (provider as unknown as { lastLoadedData: TxfStorageDataBase }).lastLoadedData =
      merged;

    // lastDiscoveredPointerCid is set to a DIFFERENT CID — A's anchor
    // for A-only state. Our merged state (A+B) won't match.
    // Issue #200 Phase 2: dag-cbor envelope CID convention.
    const aOnlyCid = await projectedFlushCid([tokenA]);
    (
      provider as unknown as { lastDiscoveredPointerCid: string | null }
    ).lastDiscoveredPointerCid = aOnlyCid;

    const flushScheduler = (
      provider as unknown as { flushScheduler: { scheduleFlushNoData: () => void } }
    ).flushScheduler;
    flushScheduler.scheduleFlushNoData();

    await new Promise((r) => setTimeout(r, 100));

    // The flush proceeded — pin was issued.
    expect(pinCallCount).toBe(1);

    // A new bundle ref was written to OrbitDB under the projected
    // (merged-state) CID, distinct from aOnlyCid. Tokens are sorted
    // by id (A < B in lexicographic order). Issue #200 Phase 2: the
    // ref CID is now the dag-cbor envelope CID, not the raw CAR-bytes CID.
    const projectedCid = await projectedFlushCid([tokenA, tokenB]);
    expect(projectedCid).not.toBe(aOnlyCid);
    expect(db._store.has(`${BUNDLE_KEY_PREFIX}${projectedCid}`)).toBe(true);

    await provider.shutdown();
  });

  it('no-data flush with no lastLoadedData and no pendingData → silent no-op', async () => {
    let pinCallCount = 0;
    installMockFetch(async (url: string) => {
      if (url.includes('/api/v0/dag/put')) {
        pinCallCount++;
        return new Response(JSON.stringify({ Cid: { '/': 'unused' } }), {
          status: 200,
        });
      }
      return new Response('', { status: 404 });
    });

    const provider = createProvider(db, { flushDebounceMs: 20 });
    await provider.initialize();

    // No lastLoadedData planted, no save() called. Trigger no-data flush —
    // there's nothing to anchor; the flush body should silently skip.
    expect(
      (provider as unknown as { lastLoadedData: TxfStorageDataBase | null })
        .lastLoadedData,
    ).toBeNull();

    const flushScheduler = (
      provider as unknown as { flushScheduler: { scheduleFlushNoData: () => void } }
    ).flushScheduler;
    flushScheduler.scheduleFlushNoData();

    await new Promise((r) => setTimeout(r, 100));

    expect(pinCallCount).toBe(0);

    await provider.shutdown();
  });
});
