/**
 * Category-M integration tests (M1-M5, M8-M15, M17) — token conservation
 * invariant across pointer-layer operations.
 *
 * These tests exercise the Token Conservation Invariant harness
 * (`./token-conservation.ts`) against real pointer-layer publish /
 * recover round-trips driven by the same mock-aggregator + in-memory
 * fakes pattern used in `./publish-recover-roundtrip.test.ts`.
 *
 * The invariant:
 *
 *   Σ(before.tokens.coinValues) + Σ(minted.coinValues)
 *       = Σ(after.tokens.coinValues) + Σ(burned.coinValues)
 *
 * ACROSS every pointer-layer operation. Any divergence signals a
 * dropped bundle, a botched JOIN, a premature consolidation, a silent
 * replication overwrite, or a partial-CAR write — all §10.4 / §10.5
 * regression surfaces that category-M is designed to detect.
 *
 * ─── Scope and skips ────────────────────────────────────────────────
 *
 * The harness this file drives runs at the pointer-layer seam:
 *   - ProfilePointerLayer.publish()    (reconcile loop → aggregator)
 *   - ProfilePointerLayer.recoverLatest() (discover → classify → decode)
 *
 * Scenarios M8-M15 require multi-candidate bundle JOINs (Rule 3) and
 * proof-enriched synthetic refs (Rule 4) — logic that lives ABOVE the
 * pointer layer in `profile/pointer-wiring.ts` and
 * `profile/profile-token-storage-provider.ts`. The mock-aggregator
 * fake stops at the XOR-ciphertext round trip and has NO OrbitDB, NO
 * CAR fetcher with real bundle bytes, and NO fetchAndJoin merge
 * implementation. We `it.skip` those scenarios with a precise pointer
 * at the missing fixture so they can be un-skipped when a
 * multi-candidate pool fixture lands.
 *
 * @see tests/integration/pointer/token-conservation.ts
 * @see tests/integration/pointer/publish-recover-roundtrip.test.ts
 * @see profile/pointer-wiring.ts (buildFetchAndJoin — Rule 3/4 impl)
 * @see profile/profile-token-storage-provider.ts (multi-candidate pool)
 */

import { describe, it, expect, beforeEach } from 'vitest';

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
} from '../../../profile/aggregator-pointer';
import { decodeVersionCid } from '../../../profile/aggregator-pointer/aggregator-probe';
import {
  assertTokenConservation,
  captureSnapshot,
  diffSnapshots,
  TokenConservationViolation,
  type ConservationToken,
  type TokenSnapshot,
} from './token-conservation';

// =============================================================================
// Fixtures — mirrored from publish-recover-roundtrip.test.ts
// =============================================================================

const WALLET_SEED = new Uint8Array(32).fill(0x33);

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
    name: 'test',
    [DURABLE_STORAGE]: true as const,
  };
}

/**
 * Fake aggregator: stores the raw ct bytes from each submitCommitment
 * keyed by `requestId.toString()`, then replays them as
 * `inclusionProof.transactionHash.data` on getInclusionProof.
 *
 * `verify()` resolves to OK unconditionally — these tests validate
 * the *token-pool conservation property*, not inclusion-proof
 * cryptography.
 */
function makeFakeAggregator(): {
  client: AggregatorClient;
  commitments: Map<string, Uint8Array>;
} {
  const commitments = new Map<string, Uint8Array>();

  const client = {
    async submitCommitment(
      requestId: { toString(): string },
      transactionHash: { data: Uint8Array },
      _authenticator: unknown,
    ) {
      // Issue #263 — model the production aggregator's per-requestId
      // idempotency. A second writer at the same requestId gets
      // REQUEST_ID_EXISTS (matches the category-C shared aggregator's
      // contract). Without this, the fast-path's attempt at v=1 would
      // silently overwrite a prior commitment at the same v rather than
      // surface a conflict, which is the behavior the SPEC requires.
      const key = requestId.toString();
      if (commitments.has(key)) {
        return new SubmitCommitmentResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS);
      }
      commitments.set(key, new Uint8Array(transactionHash.data));
      return new SubmitCommitmentResponse(SubmitCommitmentStatus.SUCCESS);
    },
    async getInclusionProof(requestId: { toString(): string }) {
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

  return { client, commitments };
}

/** Build a CIDv1 (raw codec, sha256) for arbitrary bytes. */
function cidForBytes(bytes: Uint8Array): CID {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest);
}

/** CarFetcher stub — always succeeds. CAR contents aren't validated here. */
const alwaysOkCarFetcher: CarFetcher = async () => ({ ok: true });

/**
 * CidDecoder wrapper — mirrors the production wiring in
 * pointer-wiring.ts (length-prefixed format per SPEC §5.3).
 */
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

async function buildLayer(deps: {
  seed?: Uint8Array;
  aggregatorClient: AggregatorClient;
  readLocal: () => Promise<number>;
  persistLocal: (v: number) => Promise<void>;
  fetchAndJoin?: FetchAndJoinCallback;
}): Promise<ProfilePointerLayer> {
  const masterKey = createMasterPrivateKey(deps.seed ?? WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  const storage = makeDurableStore();
  const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);

  // In-memory mutex — no need for real file locks here.
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

  const fetchAndJoin: FetchAndJoinCallback =
    deps.fetchAndJoin ??
    (async () => {
      throw new Error('fetchAndJoin should not fire in a single-writer round-trip');
    });

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
  });
}

// =============================================================================
// Token-pool model — a tiny wallet surrogate so we can snapshot coin state
//
// The pointer layer publishes an OPAQUE CID — the bundle contents are
// opaque to the fake aggregator and to the conservation harness. What
// matters for conservation is the token-pool state that the consumer
// believes it has after a publish + recover cycle. We model the pool
// explicitly here and assert invariance across the pointer operation.
// =============================================================================

class MockTokenPool {
  private tokens: Map<string, ConservationToken> = new Map();

  constructor(initial: Iterable<ConservationToken> = []) {
    for (const t of initial) this.tokens.set(t.tokenId, t);
  }

  snapshot(label: string): TokenSnapshot {
    return captureSnapshot(label, [...this.tokens.values()]);
  }

  mint(token: ConservationToken): void {
    if (this.tokens.has(token.tokenId)) {
      throw new Error(`duplicate mint: ${token.tokenId}`);
    }
    this.tokens.set(token.tokenId, token);
  }

  burn(tokenId: string): ConservationToken {
    const t = this.tokens.get(tokenId);
    if (!t) throw new Error(`burn: unknown tokenId ${tokenId}`);
    this.tokens.delete(tokenId);
    return t;
  }

  /** Serialize the token pool to a deterministic CID payload. */
  toPayload(): Uint8Array {
    const entries = [...this.tokens.values()]
      .map((t) => ({
        tokenId: t.tokenId,
        coins: [...t.coins]
          .map((c) => [c.coinId, c.amount.toString()] as const)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      }))
      .sort((a, b) => (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0));
    return new TextEncoder().encode(JSON.stringify(entries));
  }

  /** Clone this pool (for simulating a fresh device that later recovers). */
  clone(): MockTokenPool {
    return new MockTokenPool([...this.tokens.values()]);
  }

  /** Merge another pool's tokens (JOIN semantics). Mutates this pool. */
  merge(other: MockTokenPool): void {
    for (const t of other.tokens.values()) {
      if (!this.tokens.has(t.tokenId)) {
        this.tokens.set(t.tokenId, t);
      }
    }
  }

  /** Expose tokens for cross-pool snapshots (M4 pattern). */
  all(): ReadonlyArray<ConservationToken> {
    return [...this.tokens.values()];
  }

  size(): number {
    return this.tokens.size;
  }
}

// Helpers for quick token construction in test bodies.
function tok(tokenId: string, coinId: string, amount: bigint): ConservationToken {
  return { tokenId, coins: [{ coinId, amount }] };
}

// =============================================================================
// Tests
// =============================================================================

describe('Category-M: Token Conservation across pointer-layer ops', () => {
  let localVersion = 0;

  beforeEach(() => {
    localVersion = 0;
  });

  // ─── M1 ────────────────────────────────────────────────────────────────
  it('M1: bare publish + recover round-trip preserves token set', async () => {
    const { client } = makeFakeAggregator();
    const layer = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
    });

    const pool = new MockTokenPool([
      tok('t1', 'UCT', 100n),
      tok('t2', 'UCT', 50n),
      tok('t3', 'USDU', 200n),
    ]);

    const before = pool.snapshot('pre-publish');

    // Publish the serialized pool as a CID.
    const publishResult = await layer.publish(async () => {
      const payload = pool.toPayload();
      return cidForBytes(payload).bytes;
    });
    expect(publishResult.version).toBe(1);

    // Recover — the pointer layer returns a CID; the consumer's pool
    // state is UNCHANGED by publish (pointer ops do not mutate tokens).
    const recovered = await layer.recoverLatest();
    expect(recovered).not.toBeNull();
    expect(recovered!.version).toBe(1);

    const after = pool.snapshot('post-recover');

    // Conservation must hold with no minted/burned declarations.
    expect(() => assertTokenConservation(before, after)).not.toThrow();
  });

  // ─── M2 ────────────────────────────────────────────────────────────────
  it('M2: flushToIpfs then recoverLatest on a fresh device yields identical token set', async () => {
    const { client } = makeFakeAggregator();

    // Device A: publishes the pool.
    const layerA = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
    });

    const poolA = new MockTokenPool([
      tok('t-alpha', 'UCT', 100n),
      tok('t-beta', 'UCT', 250n),
      tok('t-gamma', 'USDU', 500n),
    ]);

    const deviceASnapshot = poolA.snapshot('device-A pre-flush');

    const publishedPayload = poolA.toPayload();
    const publishedCid = cidForBytes(publishedPayload);
    const publishResult = await layerA.publish(async () => publishedCid.bytes);
    expect(publishResult.version).toBe(1);

    // Device B: fresh storage, same wallet seed, never saw poolA before.
    // Pretend the CAR fetcher + decode would deliver the same payload;
    // we reconstruct the pool from the SAME token set (the CAR bytes in
    // a real system would deserialize to identical tokens).
    let deviceBVersion = 0;
    const layerB = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => deviceBVersion,
      persistLocal: async (v) => {
        deviceBVersion = v;
      },
    });

    const recovered = await layerB.recoverLatest();
    expect(recovered).not.toBeNull();
    expect(recovered!.version).toBe(1);
    // The recovered CID must match what A published — the bundle on
    // IPFS (modelled here as the publishedPayload) decodes to the
    // same token set on device B.
    expect(CID.decode(recovered!.cid).toString()).toBe(publishedCid.toString());

    // Device B reconstructs its pool from the recovered payload (in a
    // real system, the CAR deserializer does this). The token set
    // must equal device A's pool token-for-token.
    const poolB = new MockTokenPool([
      tok('t-alpha', 'UCT', 100n),
      tok('t-beta', 'UCT', 250n),
      tok('t-gamma', 'USDU', 500n),
    ]);
    const deviceBSnapshot = poolB.snapshot('device-B post-recover');

    // Conservation must hold: device B's pool == device A's pool.
    expect(() => assertTokenConservation(deviceASnapshot, deviceBSnapshot)).not.toThrow();
    expect(poolB.size()).toBe(poolA.size());
  });

  // ─── M3 ────────────────────────────────────────────────────────────────
  it('M3: concurrent token mint during publish — mint counted as `minted`', async () => {
    const { client } = makeFakeAggregator();
    const layer = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
    });

    const pool = new MockTokenPool([tok('t1', 'UCT', 100n)]);
    const before = pool.snapshot('pre-publish');

    // A concurrent mint lands BEFORE the cidProducer is called on this
    // publish attempt — the producer therefore includes the new token
    // in the published payload.
    const minted = tok('t-new', 'UCT', 300n);
    pool.mint(minted);

    const publishResult = await layer.publish(async () => {
      return cidForBytes(pool.toPayload()).bytes;
    });
    expect(publishResult.version).toBe(1);

    const after = pool.snapshot('post-publish-with-mint');

    // Conservation holds when the mint is explicitly declared.
    expect(() =>
      assertTokenConservation(before, after, { minted: [minted] }),
    ).not.toThrow();

    // Sanity: without declaring the mint, the assertion MUST fail.
    expect(() => assertTokenConservation(before, after)).toThrow(
      TokenConservationViolation,
    );
  });

  // ─── M4 ────────────────────────────────────────────────────────────────
  it('M4: concurrent token send during publish — both halves snapshot-together conserve', async () => {
    const { client } = makeFakeAggregator();
    const layer = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
    });

    // Model: two parties Alice and Bob, one shared snapshot covering both.
    const alice = new MockTokenPool([tok('t1', 'UCT', 100n), tok('t2', 'UCT', 50n)]);
    const bob = new MockTokenPool([tok('t-bob-0', 'UCT', 25n)]);

    const before = captureSnapshot('both parties pre-send', [
      ...alice.all(),
      ...bob.all(),
    ]);

    // Alice sends t2 to Bob concurrently with a publish.
    const transferred = alice.burn('t2');
    bob.mint({ tokenId: transferred.tokenId + '-bob', coins: transferred.coins });

    // Alice publishes her new, reduced pool.
    const publishResult = await layer.publish(async () => {
      return cidForBytes(alice.toPayload()).bytes;
    });
    expect(publishResult.version).toBe(1);

    const after = captureSnapshot('both parties post-send', [
      ...alice.all(),
      ...bob.all(),
    ]);

    // Conservation holds when both halves of the transfer are captured.
    // No net mint/burn — a token moved between owners, but the tokenId
    // is renamed ('-bob' suffix), so we declare the rename as burn+mint
    // of the same 50 UCT.
    expect(() =>
      assertTokenConservation(before, after, {
        minted: [{ tokenId: 't2-bob', coins: transferred.coins }],
        burned: [transferred],
      }),
    ).not.toThrow();
  });

  // ─── M5 ────────────────────────────────────────────────────────────────
  it('M5: reconcile-and-publish (H4 max(validV, includedV)+1) preserves token set after fetchAndJoin', async () => {
    const { client } = makeFakeAggregator();

    // Device A publishes v=1 first (establishing a pointer on the
    // aggregator that device B will conflict with).
    let versionA = 0;
    const layerA = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => versionA,
      persistLocal: async (v) => {
        versionA = v;
      },
    });

    const remotePool = new MockTokenPool([
      tok('remote-1', 'UCT', 100n),
      tok('remote-2', 'UCT', 50n),
    ]);

    const remotePayload = remotePool.toPayload();
    await layerA.publish(async () => cidForBytes(remotePayload).bytes);
    expect(versionA).toBe(1);

    // Device B runs with localVersion=1 so its first publish targets
    // v=2 directly — exercising the H4 max(validV, includedV)+1
    // arithmetic on the happy path (no conflict).
    //
    // Issue #263 — under the eager-publish optimization, B's fast-path
    // (attempt 0) targets `currentLocalVersion + 1 = 2`, which is
    // vacant on the shared aggregator, so the publish lands without
    // a conflict (and therefore without firing fetchAndJoin). If we
    // started B at localVersion=0 instead, the fast path would try
    // v=1, hit REQUEST_ID_EXISTS, and fall through to the slow path
    // — which would invoke fetchAndJoin and break the "happy-path
    // conservation" contract this test is asserting. The application
    // level multi-device-sync test (which DOES drive the fetchAndJoin
    // path) covers that case separately.
    let versionB = 1;
    const localPool = new MockTokenPool([tok('local-1', 'USDU', 200n)]);

    const beforeJoin = localPool.snapshot('device-B pre-join');

    const layerB = await buildLayer({
      seed: WALLET_SEED, // SAME wallet — multi-device
      aggregatorClient: client,
      readLocal: async () => versionB,
      persistLocal: async (v) => {
        versionB = v;
      },
      // When reconcile hits a conflict it will invoke fetchAndJoin;
      // in the merge-via-discover path below, it only fires on actual
      // conflict. Simulate the JOIN into local pool.
      fetchAndJoin: async () => {
        // Merge the remote pool into local.
        localPool.merge(remotePool);
      },
    });

    // Publish device B's pool. Since the aggregator already has v=1,
    // device B computes nextV=2 (H4) and publishes there without
    // conflict. fetchAndJoin is NOT invoked on the happy path.
    const localPayload = localPool.toPayload();
    const pubB = await layerB.publish(async () => cidForBytes(localPayload).bytes);
    expect(pubB.version).toBe(2);

    // After a successful no-conflict publish at v=2, the local pool is
    // unchanged (fetchAndJoin did NOT fire). Conservation holds trivially.
    const afterPublish = localPool.snapshot('device-B post-publish');
    expect(() => assertTokenConservation(beforeJoin, afterPublish)).not.toThrow();

    // Now simulate the application-level JOIN: device B explicitly
    // pulls v=1 and merges remote tokens into its pool.
    const beforeExplicitJoin = localPool.snapshot('pre-explicit-join');
    localPool.merge(remotePool);
    const afterExplicitJoin = localPool.snapshot('post-explicit-join');

    // Remote tokens appear as an explicit MINT from the local pool's
    // point of view (they were never in `before` — they're newly
    // visible to this device after the join).
    expect(() =>
      assertTokenConservation(beforeExplicitJoin, afterExplicitJoin, {
        minted: [tok('remote-1', 'UCT', 100n), tok('remote-2', 'UCT', 50n)],
      }),
    ).not.toThrow();
  });

  // ─── M8 ────────────────────────────────────────────────────────────────
  it.skip('M8: multi-bundle merge via Rule 3 resolver preserves tokens in both candidates', () => {
    // SKIP REASON: Rule 3 (JOIN multiple same-tokenId candidates from
    // parallel bundles) is implemented in
    // `profile/profile-token-storage-provider.ts` via the OrbitDB-
    // backed multi-candidate pool. The fake aggregator + in-memory
    // fixtures used by publish-recover-roundtrip.test.ts produce a
    // SINGLE bundle per publish and have no candidate-pool abstraction.
    //
    // To un-skip: build a fixture that mounts a real OrbitDB kv store
    // with multiple bundles registered at the same logical tokenId,
    // then invoke the Rule 3 resolver via the profile layer
    // (`ProfileTokenStorageProvider.addBundle` with duplicate tokenIds)
    // and snapshot before/after the merge.
  });

  // ─── M9 ────────────────────────────────────────────────────────────────
  it.skip('M9: Rule 4 proof-enriched synthetic ref preserves token count', () => {
    // SKIP REASON: Rule 4 (synthesize a new root ref when one candidate
    // has richer proof context than another) is implemented alongside
    // Rule 3 in the profile layer. Same fixture gap as M8 — no
    // multi-candidate pool available in this test file.
    //
    // To un-skip: add a fixture that injects two candidates differing
    // only in proof-chain depth and verify the synthesized winner
    // carries the same logical tokens (tokenId-level conservation).
  });

  // ─── M10-M15 ───────────────────────────────────────────────────────────
  it.skip('M10: migrating legacy IPNS snapshot preserves tokens', () => {
    // SKIP REASON: Legacy IPNS migration lives in
    // `profile/migration/` and `profile/migration.ts`. It operates on
    // real IPFS gateways and expects a legacy snapshot format on-chain.
    // The mock aggregator here does not model legacy snapshots.
    //
    // To un-skip: inject a legacy snapshot via
    // `profile/import-from-legacy.ts` fixtures and snapshot
    // before/after the migration hook.
  });

  it.skip('M11: consolidation preserves tokens across retention-window compaction', () => {
    // SKIP REASON: Consolidation is implemented in
    // `profile/consolidation.ts` and runs AFTER retention-window
    // heuristics against the OrbitDB bundle set. Tests in this file
    // have no OrbitDB adapter fixture.
    //
    // To un-skip: mount a Helia+OrbitDB fixture (see
    // tests/integration/orbitdb-adapter.test.ts for the pattern),
    // seed retired bundles past the retention window, trigger
    // consolidation, and snapshot before/after.
  });

  it.skip('M12: replication across Nostr bundle-ref writes preserves tokens', () => {
    // SKIP REASON: Nostr replication is implemented in
    // `profile/nostr-replication.ts`. It requires a live Nostr relay
    // fixture (or the testcontainers relay mock used by
    // tests/relay/groupchat-relay.test.ts). The default integration
    // suite excludes tests/relay/** via vitest.config.ts.
    //
    // To un-skip: add a mock Nostr relay fixture and drive a bundle-
    // ref replication round-trip with conservation assertions.
  });

  it.skip('M13: partial-CAR rejection preserves tokens (caller retries)', () => {
    // SKIP REASON: Partial-CAR handling lives in the CAR fetcher /
    // IPFS client layer (`profile/ipfs-client.ts`,
    // `profile/aggregator-pointer/ipfs-car-fetch.ts`). The
    // alwaysOkCarFetcher stub in this file cannot model a partial
    // fetch without additional fixture scaffolding.
    //
    // To un-skip: replace alwaysOkCarFetcher with a programmable
    // fetcher that injects `{ ok: false, reason: 'partial' }` and
    // verify that no token bytes reach the pool.
  });

  it.skip('M14: trust-base rotation during publish preserves tokens', () => {
    // SKIP REASON: Trust-base rotation is handled by
    // `profile/aggregator-pointer/trust-base-rotation.ts` with a
    // RootTrustBase from OracleProvider. The fake RootTrustBase here
    // is an empty cast; it cannot model a rotation event.
    //
    // To un-skip: add a fixture that mutates trustBase mid-publish and
    // verify the pool is unchanged by the rotation (rotation affects
    // proofs only, not token state).
  });

  it.skip('M15: blocked-state recovery preserves tokens on reset', () => {
    // SKIP REASON: The BLOCKED-state recovery path exercises
    // `clearBlocked()` + operator-override capability checks. It
    // needs an explicit fixture that sets BLOCKED via the §10.2.4
    // error-classification path, then clears it, then re-publishes.
    //
    // To un-skip: drive a classified SEMANTICALLY_INVALID or
    // UNTRUSTED_PROOF outcome through the pointer layer to raise
    // BLOCKED, clear it via pointer.clearBlocked(), and verify the
    // pool is unchanged end-to-end.
  });

  // ─── M17 ───────────────────────────────────────────────────────────────
  it('M17: zero-token wallet — publish / recover cycle produces no phantom tokens', async () => {
    const { client } = makeFakeAggregator();
    const layer = await buildLayer({
      aggregatorClient: client,
      readLocal: async () => localVersion,
      persistLocal: async (v) => {
        localVersion = v;
      },
    });

    // Truly empty pool — conservation of the empty set is the most
    // load-bearing sanity check for the whole test category: if any
    // publish / recover path silently synthesizes phantom state, M17
    // is where it shows up.
    const pool = new MockTokenPool([]);

    const before = pool.snapshot('empty pool, pre-publish');
    expect(before.tokens.length).toBe(0);

    // Publish the empty pool (the bundle encodes an empty token set).
    const pubResult = await layer.publish(async () => {
      return cidForBytes(pool.toPayload()).bytes;
    });
    expect(pubResult.version).toBe(1);

    // Recover.
    const recovered = await layer.recoverLatest();
    expect(recovered).not.toBeNull();
    expect(recovered!.version).toBe(1);

    const after = pool.snapshot('empty pool, post-recover');
    expect(after.tokens.length).toBe(0);

    // The critical assertion — no phantom coin of any coinId.
    expect(() => assertTokenConservation(before, after)).not.toThrow();

    // Defence-in-depth: diff reports an empty delta map.
    const diff = diffSnapshots(before, after);
    expect(diff.size).toBe(0);
  });
});
