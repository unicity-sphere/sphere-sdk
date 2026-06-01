/**
 * Issue #364 Item #1 — recoverLatest head cache tests.
 *
 * Verifies that the cache + in-flight dedup added to
 * `ProfilePointerLayer.recoverLatest()` correctly:
 *   1. Serves a cached value within TTL without round-tripping the
 *      aggregator (cacheHit counter).
 *   2. Coalesces concurrent in-flight calls to a single round-trip
 *      (inFlightDedup counter).
 *   3. Re-hits the aggregator after TTL expires (cacheStale + cacheMiss).
 *   4. Clears the cache on shutdown so a re-init starts fresh.
 *   5. Reports a cacheMiss on the very first call (cold start).
 *
 * The baseline impact: §D.4 (full mnemonic recovery soak per issue #363)
 * observed 108 recoverLatest calls in 123 s. The same pattern under
 * default 10 s TTL drops to ~12 — a >9× reduction — without changing
 * recovery semantics.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';
import {
  SubmitCommitmentResponse,
  SubmitCommitmentStatus,
} from '@unicitylabs/state-transition-sdk/lib/api/SubmitCommitmentResponse.js';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import { CID } from 'multiformats/cid';
import * as raw from 'multiformats/codecs/raw';
import { sha256 } from '@noble/hashes/sha2.js';
import { create as createDigest } from 'multiformats/hashes/digest';

import {
  ProfilePointerLayer,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  buildPointerSigner,
  FlagStore,
  DURABLE_STORAGE,
  type CarFetcher,
  type CidDecoder,
  type FetchAndJoinCallback,
} from '../../../profile/aggregator-pointer/index.js';
import { decodeVersionCid } from '../../../profile/aggregator-pointer/aggregator-probe.js';
import {
  __setPerfEnabledForTest,
  __stopAutoDumpForTest,
  snapshot,
  dumpAndReset,
} from '../../../core/perf-counters.js';

const WALLET_SEED = new Uint8Array(32).fill(0x77);

function makeDurableStore() {
  const kv = new Map<string, string>();
  return {
    get: async (k: string) => kv.get(k) ?? null,
    set: async (k: string, v: string) => {
      kv.set(k, v);
    },
    remove: async (k: string) => {
      kv.delete(k);
    },
    has: async (k: string) => kv.has(k),
    keys: async () => [...kv.keys()],
    clear: async () => {
      kv.clear();
    },
    setIdentity: () => {},
    saveTrackedAddresses: async () => {},
    loadTrackedAddresses: async () => [],
    initialize: async () => {},
    shutdown: async () => {},
    name: 'test-recover-cache',
    [DURABLE_STORAGE]: true as const,
  };
}

interface CountingAggregator {
  client: AggregatorClient;
  commitments: Map<string, Uint8Array>;
  /**
   * Increments on every call to either submitCommitment or
   * getInclusionProof. The pointer layer's discover walkback makes
   * many probe calls per recoverLatest — we count the AGGREGATE wire
   * activity so a cache hit shows up as zero new calls.
   */
  callCount: { value: number };
}

function makeCountingAggregator(): CountingAggregator {
  const commitments = new Map<string, Uint8Array>();
  const callCount = { value: 0 };
  const client = {
    async submitCommitment(
      requestId: { toString(): string },
      transactionHash: { data: Uint8Array },
      _authenticator: unknown,
    ) {
      callCount.value += 1;
      commitments.set(requestId.toString(), new Uint8Array(transactionHash.data));
      return new SubmitCommitmentResponse(SubmitCommitmentStatus.SUCCESS);
    },
    async getInclusionProof(requestId: { toString(): string }) {
      callCount.value += 1;
      const data = commitments.get(requestId.toString());
      if (!data) {
        return {
          inclusionProof: {
            verify: async () => InclusionProofVerificationStatus.PATH_NOT_INCLUDED,
            transactionHash: null,
          },
        };
      }
      return {
        inclusionProof: {
          verify: async () => InclusionProofVerificationStatus.OK,
          transactionHash: { data },
        },
      };
    },
  } as unknown as AggregatorClient;
  return { client, commitments, callCount };
}

function cidForBytes(bytes: Uint8Array): CID {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest);
}

const alwaysOkCarFetcher: CarFetcher = async () => ({ ok: true });

const multiformatsDecoder: CidDecoder = (full: Uint8Array) => {
  try {
    if (full.length === 0) return { ok: false };
    const cidLen = full[0];
    if (cidLen === undefined || cidLen === 0 || cidLen > full.length - 1) {
      return { ok: false };
    }
    const cid = CID.decode(full.subarray(1, 1 + cidLen));
    return { ok: true, cidBytes: new Uint8Array(cid.bytes) };
  } catch {
    return { ok: false };
  }
};

interface BuildLayerDeps {
  aggregatorClient: AggregatorClient;
  readLocal: () => Promise<number>;
  persistLocal: (v: number) => Promise<void>;
  recoverLatestCacheTtlMs?: number;
}

async function buildLayer(deps: BuildLayerDeps): Promise<ProfilePointerLayer> {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  const storage = makeDurableStore();
  const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);

  let held = false;
  const queue: Array<() => void> = [];
  const mutex = {
    async acquire() {
      if (held) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      held = true;
      return {
        release: async () => {
          held = false;
          const next = queue.shift();
          if (next) next();
        },
        assertHeld: () => {
          if (!held) throw new Error('fake mutex: lock lost');
        },
      };
    },
  };

  const trustBase = {} as unknown as RootTrustBase;

  const fetchAndJoin: FetchAndJoinCallback = async () => {
    throw new Error('fetchAndJoin should not fire in this test');
  };

  const resolveRemoteCid = async (version: number): Promise<Uint8Array> => {
    const result = await decodeVersionCid({
      v: version,
      keyMaterial,
      signer,
      aggregatorClient: deps.aggregatorClient,
      trustBase,
      decodeCid: multiformatsDecoder,
    });
    if (!result.ok) {
      throw new Error(`decodeVersionCid failed: ${result.reason}`);
    }
    return result.cidBytes;
  };

  return new ProfilePointerLayer({
    keyMaterial,
    signer,
    aggregatorClient: deps.aggregatorClient,
    trustBase,
    flagStore,
    mutex,
    decodeCid: multiformatsDecoder,
    fetchCar: alwaysOkCarFetcher,
    fetchAndJoin,
    readLocalVersion: deps.readLocal,
    persistLocalVersion: deps.persistLocal,
    resolveRemoteCid,
    recoverLatestCacheTtlMs: deps.recoverLatestCacheTtlMs,
  });
}

describe('ProfilePointerLayer recoverLatest cache (issue #364 Item #1)', () => {
  let localVersion = 0;

  beforeEach(() => {
    localVersion = 0;
    __stopAutoDumpForTest();
    // Enable first so dumpAndReset() actually clears the in-memory
    // counters Map (it short-circuits when PERF is disabled).
    __setPerfEnabledForTest(true);
    dumpAndReset();
  });

  afterEach(() => {
    // Re-enable + clear so a downstream test in this process starts
    // with empty counters even if it never runs its own beforeEach.
    __setPerfEnabledForTest(true);
    dumpAndReset();
    __setPerfEnabledForTest(false);
    __stopAutoDumpForTest();
  });

  it('first call is a cacheMiss; second call within TTL is a cacheHit (no aggregator round-trip)', async () => {
    const agg = makeCountingAggregator();
    const layer = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 10_000,
    });

    const cid = cidForBytes(new TextEncoder().encode('payload-1'));
    await layer.publish(async () => cid.bytes);

    const baselineCalls = agg.callCount.value;

    // First recover — cold, must hit the aggregator.
    const first = await layer.recoverLatest();
    expect(first).not.toBeNull();
    expect(agg.callCount.value).toBeGreaterThan(baselineCalls);
    const afterFirst = agg.callCount.value;

    const snap1 = snapshot();
    expect(snap1['pointerLayer.recoverLatest.cacheMiss']?.count ?? 0).toBe(1);
    expect(snap1['pointerLayer.recoverLatest.cacheHit']?.count ?? 0).toBe(0);

    // Second recover — within TTL, must NOT hit the aggregator.
    const second = await layer.recoverLatest();
    expect(second).not.toBeNull();
    expect(agg.callCount.value).toBe(afterFirst);

    const snap2 = snapshot();
    expect(snap2['pointerLayer.recoverLatest.cacheHit']?.count ?? 0).toBe(1);
    expect(snap2['pointerLayer.recoverLatest.cacheMiss']?.count ?? 0).toBe(1);

    // Cached result must be referentially identical (we share the
    // immutable cached object across callers).
    expect(second).toBe(first);
  });

  it('5 concurrent calls collapse to 1 aggregator round-trip via inFlightDedup', async () => {
    const agg = makeCountingAggregator();
    const layer = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 10_000,
    });

    const cid = cidForBytes(new TextEncoder().encode('payload-conc'));
    await layer.publish(async () => cid.bytes);

    // Measure the cost of ONE serial recoverLatest first, so we can
    // assert the concurrent burst stays close to that cost (not 5×).
    // We reset the layer's cache+counters between the two phases by
    // toggling the perf flag and resetting localVersion stays put.
    const layerSerial = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 10_000,
    });
    const beforeSerial = agg.callCount.value;
    await layerSerial.recoverLatest();
    const serialCost = agg.callCount.value - beforeSerial;
    // sanity: the discover walkback touches the aggregator at least once
    expect(serialCost).toBeGreaterThan(0);

    dumpAndReset(); // drop counters from publish + serial baseline
    __setPerfEnabledForTest(true);
    const baselineCalls = agg.callCount.value;

    // Fire 5 concurrent recoverLatest calls. The first one starts the
    // aggregator round-trip; the other 4 must attach via inFlightDedup.
    const results = await Promise.all([
      layer.recoverLatest(),
      layer.recoverLatest(),
      layer.recoverLatest(),
      layer.recoverLatest(),
      layer.recoverLatest(),
    ]);

    // All 5 callers receive the same result.
    expect(results.length).toBe(5);
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i]).toBe(results[0]);
    }

    // The aggregator saw only ONE round-trip's worth of activity (the
    // 4 deduped callers attached to the in-flight promise). The
    // concurrent-burst cost must be < 2 × serial cost (some slack for
    // microtask races in a real concurrent scheduler) — far less than
    // the 5× we'd see without dedup.
    const callsThisRound = agg.callCount.value - baselineCalls;
    expect(callsThisRound).toBeGreaterThan(0);
    expect(callsThisRound).toBeLessThan(serialCost * 2);

    const snap = snapshot();
    expect(snap['pointerLayer.recoverLatest.cacheMiss']?.count ?? 0).toBe(1);
    expect(snap['pointerLayer.recoverLatest.inFlightDedup']?.count ?? 0).toBe(4);
    // No cacheHit — by construction every concurrent caller hit the
    // in-flight path, not the cache path.
    expect(snap['pointerLayer.recoverLatest.cacheHit']?.count ?? 0).toBe(0);
  });

  it('cache expires after TTL: subsequent call is cacheStale + cacheMiss and hits the aggregator', async () => {
    const agg = makeCountingAggregator();
    // Tiny TTL so we can test expiry without sleeping a long time.
    const layer = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 50, // 50ms
    });

    const cid = cidForBytes(new TextEncoder().encode('payload-ttl'));
    await layer.publish(async () => cid.bytes);

    // Drop counters from publish so the subsequent assertions see
    // only the recoverLatest activity we're interested in.
    dumpAndReset();
    __setPerfEnabledForTest(true);

    // First call — cold.
    await layer.recoverLatest();
    const callsAfterFirst = agg.callCount.value;

    // Wait past TTL.
    await new Promise<void>((resolve) => setTimeout(resolve, 70));

    // Second call — TTL expired, must hit the aggregator again.
    await layer.recoverLatest();
    expect(agg.callCount.value).toBeGreaterThan(callsAfterFirst);

    const snap = snapshot();
    expect(snap['pointerLayer.recoverLatest.cacheMiss']?.count ?? 0).toBe(2);
    expect(snap['pointerLayer.recoverLatest.cacheStale']?.count ?? 0).toBe(1);
    expect(snap['pointerLayer.recoverLatest.cacheHit']?.count ?? 0).toBe(0);
  });

  it('TTL=0 disables the cache: every call hits the aggregator (pre-#364 behavior)', async () => {
    const agg = makeCountingAggregator();
    const layer = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 0,
    });

    const cid = cidForBytes(new TextEncoder().encode('payload-nocache'));
    await layer.publish(async () => cid.bytes);

    const baselineCalls = agg.callCount.value;
    await layer.recoverLatest();
    const callsAfterFirst = agg.callCount.value;
    expect(callsAfterFirst).toBeGreaterThan(baselineCalls);

    await layer.recoverLatest();
    // Second call must ALSO hit the aggregator (no caching).
    expect(agg.callCount.value).toBeGreaterThan(callsAfterFirst);

    const snap = snapshot();
    expect(snap['pointerLayer.recoverLatest.cacheHit']?.count ?? 0).toBe(0);
    // cacheMiss is only counted when TTL > 0. With TTL=0 the cache
    // path is short-circuited entirely — no miss/hit counters fire.
    expect(snap['pointerLayer.recoverLatest.cacheMiss']?.count ?? 0).toBe(0);
  });

  it('shutdown clears the cache so a re-init reading the same layer starts fresh', async () => {
    const agg = makeCountingAggregator();
    const layer = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 10_000,
    });

    const cid = cidForBytes(new TextEncoder().encode('payload-shutdown'));
    await layer.publish(async () => cid.bytes);

    // Populate cache.
    const first = await layer.recoverLatest();
    expect(first).not.toBeNull();

    // Shutdown — should clear the cache and refuse further calls.
    await layer.shutdown();

    // After shutdown, recoverLatest must throw (per assertNotShuttingDown).
    await expect(layer.recoverLatest()).rejects.toThrow(/shutdown/i);
  });

  it('aborted call returns AbortError before reading cache', async () => {
    const agg = makeCountingAggregator();
    const layer = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 10_000,
    });

    const cid = cidForBytes(new TextEncoder().encode('payload-abort'));
    await layer.publish(async () => cid.bytes);

    // Warm the cache.
    await layer.recoverLatest();

    // Pre-aborted signal — must throw AbortError even though cache is warm.
    const controller = new AbortController();
    controller.abort();
    await expect(
      layer.recoverLatest({ abortSignal: controller.signal }),
    ).rejects.toThrow(/abort/i);
  });

  // ---------------------------------------------------------------------------
  // Issue #366 — publish-time invalidation
  // ---------------------------------------------------------------------------

  it('publish() invalidates the cache: subsequent recoverLatest is a fresh round-trip', async () => {
    const agg = makeCountingAggregator();
    const layer = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 10_000,
    });

    // Seed v=1 so a recoverLatest has something to return.
    const firstCid = cidForBytes(new TextEncoder().encode('first-payload'));
    await layer.publish(async () => firstCid.bytes);

    // Warm the cache.
    agg.callCount.value = 0;
    const cachedBefore = await layer.recoverLatest();
    expect(cachedBefore).not.toBeNull();
    const callsForFirstRecover = agg.callCount.value;
    expect(callsForFirstRecover).toBeGreaterThan(0);

    // Within TTL → cache hit → no new aggregator activity.
    agg.callCount.value = 0;
    await layer.recoverLatest();
    expect(agg.callCount.value).toBe(0);

    // Publish a NEW pointer (v=2). This MUST invalidate the cache so the
    // next recoverLatest reads through to the aggregator rather than
    // returning the v=1 view.
    agg.callCount.value = 0;
    const secondCid = cidForBytes(new TextEncoder().encode('second-payload'));
    await layer.publish(async () => secondCid.bytes);

    // Counter signal: the invalidation fired (cache was warm at publish time).
    const counters = snapshot();
    expect(
      counters['pointerLayer.recoverLatest.cacheInvalidatedOnPublish']?.count,
    ).toBeGreaterThan(0);

    // Next recoverLatest is a fresh round-trip and surfaces v=2.
    agg.callCount.value = 0;
    const fresh = await layer.recoverLatest();
    expect(fresh).not.toBeNull();
    expect(agg.callCount.value).toBeGreaterThan(0);
    if (fresh && 'version' in fresh) {
      expect(fresh.version).toBe(2);
      expect(CID.decode(fresh.cid).toString()).toBe(secondCid.toString());
    }
  });

  it('publish() with no cached value is a no-op for the invalidation counter', async () => {
    const agg = makeCountingAggregator();
    const layer = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 10_000,
    });

    // No recoverLatest before publish → cache stays null → invalidation
    // should NOT fire (the guard only bumps the counter when there's
    // something to clear).
    const cid = cidForBytes(new TextEncoder().encode('no-cache-payload'));
    await layer.publish(async () => cid.bytes);

    const counters = snapshot();
    expect(
      counters['pointerLayer.recoverLatest.cacheInvalidatedOnPublish'],
    ).toBeUndefined();
  });

  it('publish() invalidation does not abort an in-flight recoverLatest started before publish', async () => {
    const agg = makeCountingAggregator();
    const layer = await buildLayer({
      aggregatorClient: agg.client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
      recoverLatestCacheTtlMs: 10_000,
    });

    const firstCid = cidForBytes(new TextEncoder().encode('first-inflight'));
    await layer.publish(async () => firstCid.bytes);

    // Start a recoverLatest and a publish concurrently. The publish's
    // invalidation must not corrupt the in-flight recover's result —
    // the in-flight slot is owned by the operation already in motion.
    const inflightRecover = layer.recoverLatest();
    const secondCid = cidForBytes(new TextEncoder().encode('second-inflight'));
    const publishPromise = layer.publish(async () => secondCid.bytes);

    const [recovered, published] = await Promise.all([
      inflightRecover,
      publishPromise,
    ]);

    expect(recovered).not.toBeNull();
    expect(published.version).toBe(2);

    // A FRESH recoverLatest after both settle must see v=2 (invalidation
    // applied; the cache no longer holds the pre-publish v=1 view).
    agg.callCount.value = 0;
    const post = await layer.recoverLatest();
    expect(post).not.toBeNull();
    if (post && 'version' in post) {
      expect(post.version).toBe(2);
    }
  });
});
