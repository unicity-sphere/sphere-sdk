/**
 * Category-C integration tests for the aggregator pointer layer (SPEC §9 —
 * reconcile / multi-device contention).
 *
 * These tests exercise the full reconcile → publish loop across TWO wallet
 * instances that share the same mnemonic (and therefore the same pointer
 * keyMaterial, signingPubKey, and mutex-key namespace) but sit on SEPARATE
 * devices — distinct FlagStores, distinct in-memory mutexes, distinct
 * `readLocalVersion` / `persistLocalVersion` callbacks, and distinct
 * in-memory IPFS fakes (since each device holds only its own locally-built
 * bundles until fetchAndJoin replicates remote state).
 *
 * The fake aggregator is SHARED between both devices: it simulates the
 * single source-of-truth that both race to land commits on. The first
 * submit at a given requestId wins with SUCCESS; any subsequent submit at
 * the same requestId is answered with REQUEST_ID_EXISTS. This is the exact
 * contract the production aggregator offers (per-requestId idempotency in
 * the SMT), which is what makes §7.3 row 5 conflict semantics trip.
 *
 * Coverage (tasks C1–C10):
 *
 *   C1   device A publishes v=1; device B recoverLatest returns the same
 *        CID. Happy-path replication — the CAR is in BOTH IPFS caches (we
 *        bridge A's bundle into B's fake IPFS before B recovers, modeling
 *        the DHT distribution assumption).
 *
 *   C2   device A and B both publish concurrently, each targeting v=1.
 *        One wins; the other receives REQUEST_ID_EXISTS+REQUEST_ID_EXISTS
 *        → §7.3 row 5 conflict → reconcileAndPublish advances to v=2
 *        after fetchAndJoin merges the winner's bundle.
 *
 *   C3   PUBLISH_RETRY_BUDGET=5 conflicts → RETRY_EXHAUSTED. Simulated by
 *        an aggregator that ALWAYS returns REQUEST_ID_EXISTS for device
 *        B's side A/B submissions, while device B's discovery walks land
 *        on an ever-advancing remote validV so the local cidProducer keeps
 *        re-targeting a bumped nextV that is likewise already occupied.
 *
 *   C4   on conflict, reconcile's fetchAndJoin callback receives the
 *        REMOTE cid bytes (the winner's), and those bytes are then
 *        observable in the local "bundle store" on next recovery.
 *
 *   C5   after fetchAndJoin, the next publish targets max(validV,
 *        includedV)+1 — the local version has advanced to the merged
 *        remote version. Verified by asserting reconcileAndPublish writes
 *        at v=validV+1, not at some earlier/stale v.
 *
 *   C6   same mnemonic, DIFFERENT HD-index seeds → different master keys
 *        → different signingPubKey → different mutexKey / blockedFlagKey
 *        / pendingVersionKey templates. No cross-contention because the
 *        pointer namespace is signingPubKey-scoped. Verified by running
 *        two concurrent publishes and observing TWO successes at v=1
 *        (each on its own requestId namespace).
 *
 *   C7   device A publishes v=1, v=2; device B imports mid-flight (fresh
 *        install, localVersion=0) and runs recoverLatest → gets v=2 CID.
 *
 *   C8   device A publishes; device B IPFS is temporarily unavailable on
 *        classifyVersion → TRANSIENT_UNAVAILABLE → discover throws
 *        CAR_UNAVAILABLE. Device B does NOT advance past a corrupt-only
 *        residue; the tokens may still exist remotely.
 *
 *   C9   device A publishes v=1..3 successfully; device B recovers later
 *        (validV=3) and its SUBSEQUENT publish targets v=4. Asserts
 *        reconcile's "max(validV, includedV)+1" rule survives a gap
 *        where local is way behind.
 *
 *   C10  two devices publish interleaved — A:v=1, B:v=2 (after fetchAndJoin
 *        from A), A:v=3 (after fetchAndJoin from B). End state: each device
 *        sees validV=3 via recover. Asserts that reconcile's fetchAndJoin
 *        callback truly updates the local version tracked by reconcile's
 *        inner loop (vs. leaving the caller to re-discover on the next
 *        publish() entry).
 *
 * Not hitting real testnet. All aggregator + IPFS interactions are in-memory.
 */

import { describe, it, expect } from 'vitest';

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
  AggregatorPointerErrorCode,
  ProfilePointerLayer,
  PUBLISH_RETRY_BUDGET,
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

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MNEMONIC_SEED = new Uint8Array(32).fill(0x42);
// C6 uses a different seed to model a different HD-derived address/index.
const MNEMONIC_SEED_OTHER_HD = new Uint8Array(32).fill(0x43);

// ── Durable storage — in-memory, one per device ────────────────────────────

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

// ── In-memory mutex — per-device (no cross-device contention needed because
// the fake aggregator serializes commits) ──────────────────────────────────

function makeInMemoryMutex() {
  let held = false;
  const queue: Array<() => void> = [];
  return {
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
}

// ── Shared fake aggregator ─────────────────────────────────────────────────
//
// Both devices point at the same aggregator instance. Submission is
// first-writer-wins per requestId; duplicates get REQUEST_ID_EXISTS.
// getInclusionProof replays the stored ciphertext (ct) so the receiving
// side can XOR-decode the CID via decodeVersionCid (the same path as the
// single-writer round-trip test).
//
// `alwaysExists` mode (for C3) answers EVERY submitCommitment with
// REQUEST_ID_EXISTS, simulating a permanently-occupied aggregator — used
// to prove that PUBLISH_RETRY_BUDGET caps the conflict-retry loop.

interface SharedAggregator {
  client: AggregatorClient;
  commitments: Map<string, Uint8Array>;
  submitCount: number;
  setAlwaysExists(flag: boolean): void;
}

function makeSharedAggregator(): SharedAggregator {
  const commitments = new Map<string, Uint8Array>();
  let alwaysExists = false;
  const state: SharedAggregator = {
    client: null as unknown as AggregatorClient,
    commitments,
    submitCount: 0,
    setAlwaysExists(flag: boolean): void {
      alwaysExists = flag;
    },
  };

  state.client = {
    async submitCommitment(
      requestId: { toString(): string },
      transactionHash: { data: Uint8Array },
      _authenticator: unknown,
    ) {
      state.submitCount += 1;
      const key = requestId.toString();
      if (alwaysExists) {
        // C3 — every slot is "already taken". Still stash the ct so that
        // getInclusionProof can replay it (otherwise discovery would see
        // PATH_NOT_INCLUDED and classify the version as not-published).
        if (!commitments.has(key)) {
          commitments.set(key, new Uint8Array(transactionHash.data));
        }
        return new SubmitCommitmentResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS);
      }
      if (commitments.has(key)) {
        // Second writer at this requestId — simulate the aggregator's
        // per-requestId idempotency gate.
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

  return state;
}

// ── Per-device in-memory IPFS ──────────────────────────────────────────────
//
// Maps CID-key (hex of CID bytes) → "is fetchable". Tests can bridge a CID
// from device A's store into device B's store to model DHT propagation
// after a fetchAndJoin, or leave it absent to model unavailability (C8).

class InMemoryIpfs {
  readonly store = new Map<string, true>();

  add(cidBytes: Uint8Array): void {
    this.store.set(bytesToHex(cidBytes), true);
  }

  has(cidBytes: Uint8Array): boolean {
    return this.store.has(bytesToHex(cidBytes));
  }

  // Always-ok fetcher for use when we unconditionally trust content
  // addressing (e.g., C5/C9 where the CID resolution path doesn't matter).
  alwaysOk: CarFetcher = async () => ({ ok: true });

  // Store-gated fetcher — returns transient_unavailable if CID not in store.
  storeGated: CarFetcher = async (cidBytes: Uint8Array) => {
    return this.has(cidBytes) ? { ok: true } : { ok: false, kind: 'transient_unavailable' };
  };
}

function bytesToHex(b: Uint8Array): string {
  let hex = '';
  for (const x of b) hex += x.toString(16).padStart(2, '0');
  return hex;
}

/** Build a CIDv1 (raw codec, sha256) for arbitrary bytes. */
function cidForBytes(bytes: Uint8Array): CID {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest);
}

// ── CidDecoder — length-prefix-aware multiformats wrapper ──────────────────

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

// ── Device ─────────────────────────────────────────────────────────────────

interface DeviceOptions {
  seed: Uint8Array;
  aggregator: AggregatorClient;
  ipfs: InMemoryIpfs;
  /** Override the default storeGated fetcher. Used for C1 happy-path. */
  fetchCar?: CarFetcher;
  /** Override fetchAndJoin. Default records into the device's IPFS so the
   * CID becomes locally resolvable on the next recover. */
  fetchAndJoin?: FetchAndJoinCallback;
}

interface Device {
  layer: ProfilePointerLayer;
  storage: ReturnType<typeof makeDurableStore>;
  readVersion: () => Promise<number>;
  persistVersion: (v: number) => Promise<void>;
  localVersion: () => number;
  setLocalVersion: (v: number) => void;
  ipfs: InMemoryIpfs;
  fetchAndJoinCalls: Array<{ remoteCid: Uint8Array; remoteVersion: number }>;
}

async function buildDevice(opts: DeviceOptions): Promise<Device> {
  const masterKey = createMasterPrivateKey(opts.seed);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  const storage = makeDurableStore();
  const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
  const mutex = makeInMemoryMutex();
  const trustBase = {} as unknown as RootTrustBase;

  let localVersion = 0;
  const readVersion = async () => localVersion;
  const persistVersion = async (v: number) => {
    localVersion = v;
  };

  const fetchAndJoinCalls: Array<{ remoteCid: Uint8Array; remoteVersion: number }> = [];
  const fetchAndJoin: FetchAndJoinCallback =
    opts.fetchAndJoin ??
    (async (remoteCid, remoteVersion) => {
      // Default: record the remote bundle into the local IPFS so the
      // subsequent resolveRemoteCid / classifyVersion can see it. Also
      // log the call so tests can inspect the callback contract.
      fetchAndJoinCalls.push({
        remoteCid: new Uint8Array(remoteCid),
        remoteVersion: remoteVersion as number,
      });
      opts.ipfs.add(remoteCid);
    });

  const fetchCar: CarFetcher = opts.fetchCar ?? opts.ipfs.storeGated;

  // resolveRemoteCid exists solely to decode ct via decodeVersionCid — it
  // does NOT need to fetch the CAR (that's the caller's fetchAndJoin).
  const resolveRemoteCid = async (version: number): Promise<Uint8Array> => {
    const result = await decodeVersionCid({
      v: version,
      keyMaterial,
      signer,
      aggregatorClient: opts.aggregator,
      trustBase,
      decodeCid: multiformatsDecoder,
    });
    if (!result.ok) {
      throw new Error(`decodeVersionCid(v=${version}) failed: ${result.reason}`);
    }
    return result.cidBytes;
  };

  const layer = new ProfilePointerLayer({
    keyMaterial,
    signer,
    aggregatorClient: opts.aggregator,
    trustBase,
    flagStore,
    mutex,
    decodeCid: multiformatsDecoder,
    fetchCar,
    fetchAndJoin,
    readLocalVersion: readVersion,
    persistLocalVersion: persistVersion,
    resolveRemoteCid,
  });

  return {
    layer,
    storage,
    readVersion,
    persistVersion,
    localVersion: () => localVersion,
    setLocalVersion: (v: number) => {
      localVersion = v;
    },
    ipfs: opts.ipfs,
    fetchAndJoinCalls,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Pointer Category-C — multi-device contention (SPEC §9)', () => {
  // ── C1: happy-path replication ───────────────────────────────────────────

  describe('C1 — device A publishes v=1; device B recovers same CID', () => {
    it('B sees A\'s CID after publish (shared aggregator + CID bridged to B\'s IPFS)', async () => {
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      const devA = await buildDevice({ seed: MNEMONIC_SEED, aggregator: agg.client, ipfs: ipfsA });
      const devB = await buildDevice({ seed: MNEMONIC_SEED, aggregator: agg.client, ipfs: ipfsB });

      const payload = new TextEncoder().encode('C1-hello');
      const cid = cidForBytes(payload);
      ipfsA.add(cid.bytes);

      const pubResult = await devA.layer.publish(async () => cid.bytes);
      expect(pubResult.version).toBe(1);
      expect(devA.localVersion()).toBe(1);

      // Model DHT propagation: A's CID is now reachable from B's IPFS.
      ipfsB.add(cid.bytes);

      const recovered = await devB.layer.recoverLatest();
      expect(recovered).not.toBeNull();
      if (!recovered) return;
      expect(recovered.version).toBe(1);
      expect(CID.decode(recovered.cid).toString()).toBe(cid.toString());
    });

    it('B without bridged CID → CAR_UNAVAILABLE (content-addressing gap)', async () => {
      // Negative control for C1: if the winner's CID is NOT in B's IPFS,
      // classifyVersion returns TRANSIENT_UNAVAILABLE and discover raises
      // CAR_UNAVAILABLE. This pins the contract that replication requires
      // the DHT layer to have propagated the CAR to B.
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      const devA = await buildDevice({ seed: MNEMONIC_SEED, aggregator: agg.client, ipfs: ipfsA });
      const devB = await buildDevice({ seed: MNEMONIC_SEED, aggregator: agg.client, ipfs: ipfsB });

      const cid = cidForBytes(new TextEncoder().encode('C1-neg'));
      ipfsA.add(cid.bytes);

      await devA.layer.publish(async () => cid.bytes);

      // ipfsB is DELIBERATELY empty for the CID → CAR fetcher returns
      // transient_unavailable → classifyVersion returns TRANSIENT_UNAVAILABLE
      // → discover-algorithm raises CAR_UNAVAILABLE.
      await expect(devB.layer.recoverLatest()).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.CAR_UNAVAILABLE,
      });
    });
  });

  // ── C2: concurrent publish race ──────────────────────────────────────────

  describe('C2 — concurrent publish at v=1; loser reconciles to v=2', () => {
    it('both devices target v=1; one wins, other reconciles + re-publishes at v=2', async () => {
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      // Use the always-ok fetcher so classifyVersion's Phase 3 CAR verify
      // doesn't gate the test on content-addressing semantics — that's
      // covered in C1. C2 is about the §7.3 row 5 → §9 reconcile loop.
      const devA = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsA,
        fetchCar: ipfsA.alwaysOk,
      });
      const devB = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsB,
        fetchCar: ipfsB.alwaysOk,
      });

      const cidA = cidForBytes(new TextEncoder().encode('C2-deviceA'));
      const cidB = cidForBytes(new TextEncoder().encode('C2-deviceB'));

      // Kick off both publishes "concurrently" — the in-memory aggregator
      // serializes the submits, so whichever hits first at (requestId_v1,
      // side=A) wins that slot. With await-ordering, A starts first and
      // wins; B gets EXISTS+EXISTS → conflict → reconcile → publish at v=2.
      const [resA, resB] = await Promise.all([
        devA.layer.publish(async () => cidA.bytes),
        devB.layer.publish(async () => cidB.bytes),
      ]);

      // One device landed v=1, the other v=2 (order depends on microtask
      // scheduling — we don't pin which).
      const versions = [resA.version, resB.version].sort();
      expect(versions).toEqual([1, 2]);

      // The reconcile device used strictly more than one attempt (consumed
      // at least one conflict-retry slot out of PUBLISH_RETRY_BUDGET).
      const loser = resA.attemptsUsed > resB.attemptsUsed ? resA : resB;
      const winner = loser === resA ? resB : resA;
      expect(winner.attemptsUsed).toBe(1);
      expect(loser.attemptsUsed).toBeGreaterThan(1);
      expect(loser.attemptsUsed).toBeLessThanOrEqual(PUBLISH_RETRY_BUDGET);

      // The loser's fetchAndJoin was invoked with the WINNER's CID at v=1.
      const loserDev = loser === resA ? devA : devB;
      expect(loserDev.fetchAndJoinCalls.length).toBeGreaterThanOrEqual(1);
      const firstJoin = loserDev.fetchAndJoinCalls[0]!;
      expect(firstJoin.remoteVersion).toBe(1);
      const winnerCid = winner === resA ? cidA : cidB;
      expect(bytesToHex(firstJoin.remoteCid)).toBe(bytesToHex(winnerCid.bytes));
    });
  });

  // ── C3: PUBLISH_RETRY_BUDGET exhaustion ──────────────────────────────────

  describe('C3 — PUBLISH_RETRY_BUDGET=5 conflicts → RETRY_EXHAUSTED', () => {
    it('always-exists aggregator drives RETRY_EXHAUSTED after 5 conflict attempts', async () => {
      const agg = makeSharedAggregator();
      const ipfsB = new InMemoryIpfs();

      // Prime the commitments so that discovery classifies v=1 as "included"
      // (otherwise discovery returns validV=0, includedV=0 which is the
      // fresh-wallet path — B would then publish at v=1 and get conflict
      // once, not exhaust the budget).
      //
      // We populate both sides' commitments for v=1 by running one successful
      // publish through a transient "normal" mode, then flip the aggregator
      // into always-exists mode for the test itself.
      const ipfsPrimer = new InMemoryIpfs();
      const primer = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsPrimer,
        fetchCar: ipfsPrimer.alwaysOk,
      });
      const primerCid = cidForBytes(new TextEncoder().encode('C3-primer'));
      await primer.layer.publish(async () => primerCid.bytes);

      // Now EVERY subsequent submit returns REQUEST_ID_EXISTS — the
      // aggregator is "permanently occupied" from device B's point of view.
      // Discovery will find validV=1 on each attempt, advance to v=2, hit
      // REQUEST_ID_EXISTS (always-exists mode also stashes the ct so the
      // probe decodes a valid CID), then conflict-retry, and so on.
      //
      // After PUBLISH_RETRY_BUDGET attempts, reconcileAndPublish raises
      // RETRY_EXHAUSTED.
      agg.setAlwaysExists(true);

      // On-ring bridging: every CID the device sees via fetchAndJoin must be
      // fetchable by its own fetchCar so classifyVersion can certify VALID.
      const devB = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: new InMemoryIpfs(),
        fetchCar: async () => ({ ok: true }), // all CARs accepted
      });

      const cidB = cidForBytes(new TextEncoder().encode('C3-deviceB'));

      await expect(devB.layer.publish(async () => cidB.bytes)).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.RETRY_EXHAUSTED,
        details: { maxAttempts: PUBLISH_RETRY_BUDGET },
      });

      // Budget accounting sanity: fetchAndJoin fired PUBLISH_RETRY_BUDGET
      // times — once per conflict-retry iteration.
      expect(devB.fetchAndJoinCalls.length).toBe(PUBLISH_RETRY_BUDGET);
    });
  });

  // ── C4: fetchAndJoin receives remote CID ─────────────────────────────────

  describe('C4 — on conflict, fetchAndJoin gets the remote CID bytes', () => {
    it('loser\'s fetchAndJoin callback is invoked with winner\'s CID + version', async () => {
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      const devA = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsA,
        fetchCar: ipfsA.alwaysOk,
      });

      const loserRecordedCids: Uint8Array[] = [];
      const loserRecordedVersions: number[] = [];
      const devB = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsB,
        fetchCar: ipfsB.alwaysOk,
        fetchAndJoin: async (remoteCid, remoteVersion) => {
          loserRecordedCids.push(new Uint8Array(remoteCid));
          loserRecordedVersions.push(remoteVersion as number);
          // Bridge into B's IPFS for subsequent classifyVersion passes.
          ipfsB.add(remoteCid);
        },
      });

      const cidA = cidForBytes(new TextEncoder().encode('C4-A'));
      const cidB = cidForBytes(new TextEncoder().encode('C4-B'));

      // Concurrent race (same as C2 harness): with Promise.all and awaits
      // interleaved, A's submit hits the aggregator at (requestId_v1, side=A)
      // first — B's second write gets REQUEST_ID_EXISTS on both sides →
      // §7.3 row 5 conflict → reconcile → fetchAndJoin fires with A's CID.
      //
      // Contrast with the sequential version (`await A; await B`), where B's
      // initial discovery already sees A's commit and targets v=2 on the
      // FIRST attempt — no conflict, no fetchAndJoin. The contract we pin
      // here is specifically the conflict-path fetchAndJoin payload.
      const [resA, resB] = await Promise.all([
        devA.layer.publish(async () => cidA.bytes),
        devB.layer.publish(async () => cidB.bytes),
      ]);

      // One device lands v=1, the other v=2.
      const versions = [resA.version, resB.version].sort();
      expect(versions).toEqual([1, 2]);
      const winner = resA.version === 1 ? resA : resB;
      const loserDev = resA.version === 1 ? devB : devA;
      const winnerCid = winner === resA ? cidA : cidB;

      // The losing device's fetchAndJoin fired at least once — exactly with
      // the winner's CID at v=1. (Additional fires may appear on further
      // conflict-retry iterations if there were any; first one is the one
      // we pin.)
      const losersRecorded = loserDev === devB ? loserRecordedCids : devA.fetchAndJoinCalls.map((c) => c.remoteCid);
      const losersVersions = loserDev === devB ? loserRecordedVersions : devA.fetchAndJoinCalls.map((c) => c.remoteVersion);
      expect(losersRecorded.length).toBeGreaterThanOrEqual(1);
      expect(losersVersions[0]).toBe(1);
      expect(bytesToHex(losersRecorded[0]!)).toBe(bytesToHex(winnerCid.bytes));
    });
  });

  // ── C5: after fetchAndJoin, nextV = max(validV, includedV) + 1 ──────────

  describe('C5 — after fetchAndJoin, next publish targets max(validV, includedV)+1', () => {
    it('B conflicts at v=1, joins A\'s state, then publishes at v=2 (not v=1 again)', async () => {
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      const devA = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsA,
        fetchCar: ipfsA.alwaysOk,
      });
      const devB = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsB,
        fetchCar: ipfsB.alwaysOk,
      });

      const cidA = cidForBytes(new TextEncoder().encode('C5-A'));
      const cidB = cidForBytes(new TextEncoder().encode('C5-B'));

      await devA.layer.publish(async () => cidA.bytes);
      const resB = await devB.layer.publish(async () => cidB.bytes);

      expect(resB.version).toBe(2);
      // Post-publish: B's persisted localVersion is the version it landed.
      expect(devB.localVersion()).toBe(2);
      // And A's is still 1 — B's publish didn't retroactively mutate A.
      expect(devA.localVersion()).toBe(1);

      // Both commits now exist in the aggregator; both versions are
      // recoverable. Recovery from either device finds validV=2.
      expect((await devA.layer.discoverLatestVersion()).validV).toBe(2);
      expect((await devB.layer.discoverLatestVersion()).validV).toBe(2);
    });
  });

  // ── C6: different HD index → different signingPubKey → no contention ────

  describe('C6 — different HD index → disjoint namespace → no contention', () => {
    it('two seeds publish concurrently at v=1 on their own requestId rings', async () => {
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      const devA = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsA,
        fetchCar: ipfsA.alwaysOk,
      });
      const devB = await buildDevice({
        seed: MNEMONIC_SEED_OTHER_HD, // distinct HD index → distinct keyMaterial
        aggregator: agg.client,
        ipfs: ipfsB,
        fetchCar: ipfsB.alwaysOk,
      });

      const cidA = cidForBytes(new TextEncoder().encode('C6-A'));
      const cidB = cidForBytes(new TextEncoder().encode('C6-B'));

      const [resA, resB] = await Promise.all([
        devA.layer.publish(async () => cidA.bytes),
        devB.layer.publish(async () => cidB.bytes),
      ]);

      // NO contention — both land at v=1 on their own requestId namespaces.
      expect(resA.version).toBe(1);
      expect(resB.version).toBe(1);
      expect(resA.attemptsUsed).toBe(1);
      expect(resB.attemptsUsed).toBe(1);

      // And neither device's fetchAndJoin fired.
      expect(devA.fetchAndJoinCalls.length).toBe(0);
      expect(devB.fetchAndJoinCalls.length).toBe(0);
    });
  });

  // ── C7: import-mid-flight recovery ───────────────────────────────────────

  describe('C7 — fresh-install device B recovers A\'s latest publish', () => {
    it('A publishes v=1, v=2; B (localVersion=0) recoverLatest returns v=2 CID', async () => {
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      const devA = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsA,
        fetchCar: ipfsA.alwaysOk,
      });

      const cid1 = cidForBytes(new TextEncoder().encode('C7-v1'));
      const cid2 = cidForBytes(new TextEncoder().encode('C7-v2'));

      await devA.layer.publish(async () => cid1.bytes);
      await devA.layer.publish(async () => cid2.bytes);
      expect(devA.localVersion()).toBe(2);

      // Device B imports the mnemonic AFTER A has already published twice.
      // localVersion = 0 (fresh install, nothing on disk).
      //
      // Bridge the latest CID into B's IPFS to model successful DHT
      // propagation. classifyVersion walks Phase 3 down from includedV=2,
      // lands on v=2 as VALID, returns it as validV.
      ipfsB.add(cid2.bytes);
      const devB = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsB,
      });

      const recovered = await devB.layer.recoverLatest();
      expect(recovered).not.toBeNull();
      if (!recovered) return;
      expect(recovered.version).toBe(2);
      expect(CID.decode(recovered.cid).toString()).toBe(cid2.toString());
    });
  });

  // ── C8: IPFS temporarily unavailable for device B ───────────────────────

  describe('C8 — B\'s IPFS unavailable → CAR_UNAVAILABLE (no silent walkpast)', () => {
    it('latest valid version\'s CAR transiently missing → discover raises CAR_UNAVAILABLE', async () => {
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      const devA = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsA,
        fetchCar: ipfsA.alwaysOk,
      });

      await devA.layer.publish(async () => cidForBytes(new TextEncoder().encode('C8-v1')).bytes);

      // Every CAR fetch returns transient_unavailable — B's gateway is down.
      const fetchCar: CarFetcher = async () => ({
        ok: false,
        kind: 'transient_unavailable',
      });

      const devB = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsB,
        fetchCar,
      });

      await expect(devB.layer.recoverLatest()).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.CAR_UNAVAILABLE,
      });
    });
  });

  // ── C9: local-way-behind recovery ────────────────────────────────────────

  describe('C9 — device B many versions behind; next publish targets validV+1', () => {
    it('A publishes v=1..3; B imports (localVersion=0) and next publish → v=4', async () => {
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      const devA = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsA,
        fetchCar: ipfsA.alwaysOk,
      });

      const cids = [1, 2, 3].map((i) => cidForBytes(new TextEncoder().encode(`C9-v${i}`)));
      for (const cid of cids) {
        await devA.layer.publish(async () => cid.bytes);
      }
      expect(devA.localVersion()).toBe(3);

      // B's IPFS has the latest CID so classifyVersion(v=3) → VALID.
      ipfsB.add(cids[2]!.bytes);
      const devB = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsB,
      });

      // B publishes once. It starts at localVersion=0.
      //
      // Issue #263 fast-path-miss path (cold-start): attempt 0 targets
      // v=1 (currentLocalVersion + 1) and gets REQUEST_ID_EXISTS from
      // the shared aggregator (A already holds v=1). reconcile then
      // falls back to its existing rediscover + slow-path discovery,
      // finds validV=3 includedV=3, targets v=4 (H4), and lands —
      // total 2 attempts. The final version is unchanged from the
      // pre-fast-path behavior.
      const cidB = cidForBytes(new TextEncoder().encode('C9-vB'));
      const resB = await devB.layer.publish(async () => cidB.bytes);
      expect(resB.version).toBe(4);
      expect(resB.attemptsUsed).toBe(2); // attempt 0 (v=1) conflict + attempt 1 (v=4) success.
      expect(devB.localVersion()).toBe(4);
    });
  });

  // ── C10: interleaved publish — A, B, A ───────────────────────────────────

  describe('C10 — interleaved publish across two devices lands versions monotonically', () => {
    it('A:v=1 → B:v=2 → A:v=3; both devices converge to validV=3', async () => {
      const agg = makeSharedAggregator();
      const ipfsA = new InMemoryIpfs();
      const ipfsB = new InMemoryIpfs();

      const devA = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsA,
        fetchCar: ipfsA.alwaysOk,
      });
      const devB = await buildDevice({
        seed: MNEMONIC_SEED,
        aggregator: agg.client,
        ipfs: ipfsB,
        fetchCar: ipfsB.alwaysOk,
      });

      const cidA1 = cidForBytes(new TextEncoder().encode('C10-A1'));
      const cidB2 = cidForBytes(new TextEncoder().encode('C10-B2'));
      const cidA3 = cidForBytes(new TextEncoder().encode('C10-A3'));

      // A:v=1 (no contention)
      const rA1 = await devA.layer.publish(async () => cidA1.bytes);
      expect(rA1.version).toBe(1);

      // B publishes: B's localVersion=0.
      //
      // Issue #263 fast-path-miss path: attempt 0 targets v=1 and
      // conflicts (A already holds v=1). Fall-back rediscovers
      // validV=1, attempt 1 targets v=2 → success.
      // NOTE: B doesn't run fetchAndJoin for the file-store CIDs in
      // this test (resolveRemoteCid stub), but the conflict + walkback
      // still bumps to v=2 deterministically.
      const rB2 = await devB.layer.publish(async () => cidB2.bytes);
      expect(rB2.version).toBe(2);
      expect(rB2.attemptsUsed).toBe(2); // attempt 0 (v=1) conflict + attempt 1 (v=2) success.

      // A publishes again: A's localVersion is 1 (after own publish).
      // Issue #263 fast-path-miss: attempt 0 targets v=2 and conflicts
      // (B just landed v=2). Fall-back to walkback finds validV=2,
      // attempt 1 targets v=3 → success.
      const rA3 = await devA.layer.publish(async () => cidA3.bytes);
      expect(rA3.version).toBe(3);
      expect(rA3.attemptsUsed).toBe(2); // attempt 0 (v=2) conflict + attempt 1 (v=3) success.

      // Both devices now converge to validV=3 on discover (each discovers
      // independently — they share the aggregator).
      expect((await devA.layer.discoverLatestVersion()).validV).toBe(3);
      expect((await devB.layer.discoverLatestVersion()).validV).toBe(3);

      // Persisted localVersion tracks each device's last-successful publish.
      expect(devA.localVersion()).toBe(3);
      expect(devB.localVersion()).toBe(2);
    });
  });
});
