/**
 * Category-G integration tests — SPEC §10.7 CAR-unavailable operator override.
 *
 * Exercises the full `acceptCarLoss()` flow end-to-end against a fake
 * aggregator + in-memory FlagStore. Complements the per-function unit tests
 * in tests/unit/profile/pointer/car-loss-tracker.test.ts by wiring the
 * persistent-retry ledger through the public ProfilePointerLayer API.
 *
 * Coverage (G1–G7):
 *
 *   G1  recordCarFetchFailure accumulates attempts in the durable ledger,
 *       keyed per (version, gateway).
 *
 *   G2  canInvokeAcceptCarLoss returns eligible=false before the wall-clock
 *       gate (24h) has elapsed from the first recorded attempt — even when
 *       the attempt count threshold is satisfied.
 *
 *   G3  canInvokeAcceptCarLoss returns eligible=true once BOTH the attempt
 *       count (12) AND the wall-clock span
 *       (CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS = 24h) are satisfied.
 *
 *   G4  acceptCarLoss throws CAPABILITY_DENIED when the layer is constructed
 *       without allowOperatorOverrides=true — the capability gate fires
 *       BEFORE the wall-clock gate, so ineligibility data has no effect.
 *
 *   G5  acceptCarLoss throws UNREACHABLE_RECOVERY_BLOCKED when the operator
 *       capability is granted but the H7 wall-clock gate has not yet been
 *       satisfied. The error must carry the distinct
 *       UNREACHABLE_RECOVERY_BLOCKED code (not CAR_UNAVAILABLE or
 *       CAPABILITY_DENIED) so UIs can show the "please keep trying" state.
 *
 *   G6  successful acceptCarLoss MANDATORILY calls publish() BEFORE returning
 *       — the H7 step-4 "republish-before-advance" discipline. We verify this
 *       by spying on the layer's publish method (which is the caller-level
 *       republish hook) and asserting it ran exactly once before the return.
 *
 *   G7  after acceptCarLoss succeeds, the CAR-loss ledger for that version
 *       is cleared (clearAttempts). This prevents the next pointer-layer
 *       recovery attempt from inheriting stale attempt history.
 *
 * The fake aggregator is adapted from publish-recover-roundtrip.test.ts:
 * it echoes ct bytes submitted via submitCommitment as the
 * inclusionProof.transactionHash.data on getInclusionProof, yielding a
 * minimal successful publish path for G6/G7 without real network I/O.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS,
  CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
  DURABLE_STORAGE,
  FlagStore,
  ProfilePointerLayer,
  buildPointerSigner,
  canInvokeAcceptCarLoss,
  clearAttempts,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  getAttempts,
  recordAttempt,
  type CarFetcher,
  type CidDecoder,
  type FetchAndJoinCallback,
  type PointerLayerConfig,
} from '../../../profile/aggregator-pointer/index.js';
import { decodeVersionCid } from '../../../profile/aggregator-pointer/aggregator-probe.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const WALLET_SEED = new Uint8Array(32).fill(0x55);
const GATEWAY_A = 'https://ipfs.example.com';
const GATEWAY_B = 'https://gateway2.example.com';

/** In-memory DurableStorageProvider — same shape as publish-recover-roundtrip.test.ts. */
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
 * Fake aggregator — stores the raw ct bytes on submitCommitment and echoes
 * them as inclusionProof.transactionHash.data on getInclusionProof so the
 * pointer layer can XOR-decode them back into the original CID.
 *
 * verify() resolves to OK unconditionally: the test is not validating
 * inclusion-proof cryptography, only the publish-layer republish hook.
 */
function makeFakeAggregator(): {
  client: AggregatorClient;
  commitments: Map<string, Uint8Array>;
  submitCalls: number;
} {
  const commitments = new Map<string, Uint8Array>();
  const state = { submitCalls: 0 };

  const client = {
    async submitCommitment(
      requestId: { toString(): string },
      transactionHash: { data: Uint8Array },
      _authenticator: unknown,
    ) {
      state.submitCalls += 1;
      commitments.set(requestId.toString(), new Uint8Array(transactionHash.data));
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

  return {
    client,
    commitments,
    get submitCalls() {
      return state.submitCalls;
    },
  } as unknown as {
    client: AggregatorClient;
    commitments: Map<string, Uint8Array>;
    submitCalls: number;
  };
}

/** Build a CIDv1 (raw codec, sha256) for arbitrary bytes. */
function cidForBytes(bytes: Uint8Array): CID {
  const digest = createDigest(0x12, sha256(bytes));
  return CID.createV1(raw.code, digest);
}

/** CarFetcher stub — always succeeds (CAR contents not validated at this layer). */
const alwaysOkCarFetcher: CarFetcher = async () => ({ ok: true });

/**
 * CidDecoder wrapper — mirrors publish-recover-roundtrip.test.ts. The 64-byte
 * `full` buffer is length-prefixed per SPEC §5.3: byte 0 is `cidLen`,
 * bytes [1..1+cidLen] are the raw CID, the rest is derived padding.
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

interface BuiltLayer {
  layer: ProfilePointerLayer;
  flagStore: FlagStore;
  fakeAggregator: ReturnType<typeof makeFakeAggregator>;
  readLocal: () => Promise<number>;
  persistCalls: number[];
}

async function buildLayer(opts: {
  config?: PointerLayerConfig;
  initialLocalVersion?: number;
} = {}): Promise<BuiltLayer> {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  const storage = makeDurableStore();
  const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);

  // In-memory mutex — no cross-process fsync needed for this test suite.
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

  const fakeAggregator = makeFakeAggregator();
  const trustBase = {} as unknown as RootTrustBase;

  const fetchAndJoin: FetchAndJoinCallback = async () => {
    throw new Error('fetchAndJoin should not fire in category-G tests');
  };

  let localVersion = opts.initialLocalVersion ?? 0;
  const persistCalls: number[] = [];

  const readLocal = async () => localVersion;
  const persistLocal = async (v: number) => {
    localVersion = v;
    persistCalls.push(v);
  };

  const resolveRemoteCid = async (version: number): Promise<Uint8Array> => {
    const result = await decodeVersionCid({
      v: version,
      keyMaterial,
      signer,
      aggregatorClient: fakeAggregator.client,
      trustBase,
      decodeCid: multiformatsDecoder,
    });
    if (!result.ok) {
      throw new Error(`decodeVersionCid failed: ${result.reason}`);
    }
    return result.cidBytes;
  };

  const layer = new ProfilePointerLayer({
    keyMaterial,
    signer,
    aggregatorClient: fakeAggregator.client,
    trustBase,
    flagStore,
    mutex,
    decodeCid: multiformatsDecoder,
    fetchCar: alwaysOkCarFetcher,
    fetchAndJoin,
    readLocalVersion: readLocal,
    persistLocalVersion: persistLocal,
    resolveRemoteCid,
    config: opts.config,
  });

  return { layer, flagStore, fakeAggregator, readLocal, persistCalls };
}

// ── Env management for capability gates ───────────────────────────────────

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_ALLOW_OVERRIDES = process.env.SPHERE_ALLOW_OVERRIDES;

function setOverridesPermitted(): void {
  // Anything non-production is fine for the T-E26 guard; we use 'test' which
  // is the ecosystem convention under vitest. SPHERE_ALLOW_OVERRIDES must be
  // '1' to match the constants.ts value — no other value unlocks the gate.
  process.env.NODE_ENV = 'test';
  process.env.SPHERE_ALLOW_OVERRIDES = '1';
}

function restoreEnv(): void {
  if (ORIGINAL_NODE_ENV !== undefined) process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  else delete process.env.NODE_ENV;
  if (ORIGINAL_ALLOW_OVERRIDES !== undefined) {
    process.env.SPHERE_ALLOW_OVERRIDES = ORIGINAL_ALLOW_OVERRIDES;
  } else {
    delete process.env.SPHERE_ALLOW_OVERRIDES;
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Pointer Category-G integration — §10.7 CAR-unavailable operator override', () => {
  beforeEach(() => {
    // Default: overrides NOT permitted. G4 relies on this.
    delete process.env.NODE_ENV;
    delete process.env.SPHERE_ALLOW_OVERRIDES;
  });

  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  // ── G1: recordCarFetchFailure persists per-(version, gateway) attempts ───

  describe('G1 — recordCarFetchFailure accumulates attempts per version and gateway', () => {
    it('records multiple attempts across distinct gateways and versions', async () => {
      // Construct the layer without operator overrides — recordCarFetchFailure
      // is NOT a gated API (it's called by the recovery loop on every IPFS
      // failure, before any operator consent exists).
      const { layer, flagStore } = await buildLayer();

      await layer.recordCarFetchFailure(5, GATEWAY_A);
      await layer.recordCarFetchFailure(5, GATEWAY_B);
      await layer.recordCarFetchFailure(6, GATEWAY_A);

      const v5 = await getAttempts(flagStore, 5);
      const v6 = await getAttempts(flagStore, 6);

      expect(v5.length).toBe(2);
      // Order preserved — append-only ledger.
      expect(v5[0]!.gateway).toBe(GATEWAY_A);
      expect(v5[1]!.gateway).toBe(GATEWAY_B);
      // Each attempt carries its own wall-clock timestamp (now-based).
      expect(typeof v5[0]!.ts).toBe('number');
      expect(v5[0]!.ts).toBeGreaterThan(0);

      // v=6 ledger is independent — no cross-version contamination.
      expect(v6.length).toBe(1);
      expect(v6[0]!.gateway).toBe(GATEWAY_A);
    });

    it('persists across a fresh FlagStore view (durable ledger)', async () => {
      // The H7 gate requires durability across process restarts. Simulate by
      // constructing two layers over the same DurableStorageProvider — the
      // second layer must see the first layer's recorded attempts.
      const masterKey = createMasterPrivateKey(WALLET_SEED);
      const keyMaterial = derivePointerKeyMaterial(masterKey);
      const signer = await buildPointerSigner(keyMaterial.signingSeed);
      const storage = makeDurableStore();
      const fsA = FlagStore.create(storage as never, signer.signingPubKeyHex);

      await recordAttempt(fsA, 7, GATEWAY_A, 1000);

      // "Restart": build a fresh FlagStore over the same storage.
      const fsB = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const attempts = await getAttempts(fsB, 7);
      expect(attempts).toEqual([{ ts: 1000, gateway: GATEWAY_A }]);
    });
  });

  // ── G2: canInvokeAcceptCarLoss false before wall-clock elapsed ──────────

  describe('G2 — canInvokeAcceptCarLoss false before wall-clock gate', () => {
    it('returns ineligible when attempt count satisfied but wall-clock span too short', async () => {
      const { flagStore } = await buildLayer();
      // Record 12 attempts, all within a compressed 11-minute window
      // (1 minute per record). Count threshold met (12 >= 12) but wall-clock
      // span (11min < 24h) is insufficient.
      for (let i = 0; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS; i++) {
        await recordAttempt(flagStore, 9, GATEWAY_A, i * 60_000);
      }
      const elevenMinutesAfterFirst = (CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS - 1) * 60_000;
      const gate = await canInvokeAcceptCarLoss(flagStore, 9, elevenMinutesAfterFirst);

      expect(gate.eligible).toBe(false);
      expect(gate.attemptCount).toBe(CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS);
      expect(gate.attemptsRemaining).toBe(0);
      // Wall-clock is still the limiting factor — almost the full 24h remains.
      expect(gate.msRemaining).toBeGreaterThan(0);
      expect(gate.msRemaining).toBe(
        CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS - elevenMinutesAfterFirst,
      );
    });

    it('returns ineligible when zero attempts recorded (gate fully un-satisfied)', async () => {
      const { flagStore } = await buildLayer();
      const gate = await canInvokeAcceptCarLoss(flagStore, 9, Date.now());
      expect(gate.eligible).toBe(false);
      expect(gate.attemptCount).toBe(0);
      expect(gate.attemptsRemaining).toBe(CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS);
    });
  });

  // ── G3: canInvokeAcceptCarLoss true after gate elapsed ──────────────────

  describe('G3 — canInvokeAcceptCarLoss true after POINTER_CAR_LOSS_GATE_MS', () => {
    it('returns eligible when BOTH attempt count AND wall-clock span satisfied', async () => {
      const { flagStore } = await buildLayer();
      // First attempt at t=0; remaining attempts clustered at t=24h. The
      // wall-clock anchor is the FIRST recorded attempt (firstAttemptTs),
      // so one attempt at t=0 and eleven at t=24h satisfies both the count
      // (12) and the span (24h).
      await recordAttempt(flagStore, 11, GATEWAY_A, 0);
      for (let i = 1; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS; i++) {
        await recordAttempt(
          flagStore,
          11,
          GATEWAY_A,
          CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
        );
      }
      const gate = await canInvokeAcceptCarLoss(
        flagStore,
        11,
        CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
      );

      expect(gate.eligible).toBe(true);
      expect(gate.attemptsRemaining).toBe(0);
      expect(gate.msRemaining).toBe(0);
      expect(gate.elapsedMs).toBe(CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS);
    });
  });

  // ── G4: acceptCarLoss throws CAPABILITY_DENIED when overrides disabled ──

  describe('G4 — acceptCarLoss requires allowOperatorOverrides=true', () => {
    it('throws CAPABILITY_DENIED when constructed WITHOUT allowOperatorOverrides', async () => {
      // No SPHERE_ALLOW_OVERRIDES env, no allowOperatorOverrides in config.
      const { layer } = await buildLayer({ config: {} });

      const cid = cidForBytes(new TextEncoder().encode('never-invoked'));
      await expect(
        layer.acceptCarLoss(5, async () => cid.bytes),
      ).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.CAPABILITY_DENIED,
      });
    });

    it('CAPABILITY_DENIED fires BEFORE the wall-clock gate — message references acceptCarLoss', async () => {
      // Even when the H7 gate IS satisfied, the capability gate fires first.
      // This asserts the gate ordering: capability > wall-clock > republish.
      const { layer, flagStore } = await buildLayer({ config: {} });

      // Satisfy the H7 gate fully — proves capability check runs ahead of it.
      await recordAttempt(flagStore, 5, GATEWAY_A, 0);
      for (let i = 1; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS; i++) {
        await recordAttempt(
          flagStore,
          5,
          GATEWAY_A,
          CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
        );
      }

      const cid = cidForBytes(new TextEncoder().encode('never-invoked'));
      try {
        await layer.acceptCarLoss(5, async () => cid.bytes);
        expect.fail('should have thrown CAPABILITY_DENIED');
      } catch (err) {
        expect((err as { code?: string }).code).toBe(
          AggregatorPointerErrorCode.CAPABILITY_DENIED,
        );
        // Error message identifies the gated API — helps operators diagnose.
        expect((err as Error).message).toContain('acceptCarLoss');
      }
    });
  });

  // ── G5: acceptCarLoss throws UNREACHABLE_RECOVERY_BLOCKED before gate ────

  describe('G5 — acceptCarLoss throws UNREACHABLE_RECOVERY_BLOCKED when gate not met', () => {
    it('overrides granted but wall-clock unsatisfied → UNREACHABLE_RECOVERY_BLOCKED', async () => {
      setOverridesPermitted();
      const { layer, flagStore } = await buildLayer({
        config: { allowOperatorOverrides: true },
      });

      // Record only 3 attempts in rapid succession — fails BOTH conditions.
      await layer.recordCarFetchFailure(5, GATEWAY_A);
      await layer.recordCarFetchFailure(5, GATEWAY_B);
      await layer.recordCarFetchFailure(5, GATEWAY_A);

      const cid = cidForBytes(new TextEncoder().encode('never-invoked'));

      await expect(
        layer.acceptCarLoss(5, async () => cid.bytes),
      ).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.UNREACHABLE_RECOVERY_BLOCKED,
      });

      // Ledger is NOT cleared on gate-fail — the partial progress must be
      // preserved so the user can continue accumulating attempts toward the
      // gate. G7 asserts the complementary "clear on success" behavior.
      const attempts = await getAttempts(flagStore, 5);
      expect(attempts.length).toBe(3);
    });
  });

  // ── G6: successful acceptCarLoss republishes BEFORE advancing (H7 step 4) ─

  describe('G6 — successful acceptCarLoss republishes before advancing', () => {
    it('runs the publish flow exactly once during the acceptCarLoss flow', async () => {
      setOverridesPermitted();
      const { layer, flagStore, fakeAggregator } = await buildLayer({
        config: { allowOperatorOverrides: true },
      });

      // Satisfy the H7 gate: 1 attempt at t=0, then 11 attempts at t=24h.
      // The ledger's firstAttemptTs anchors on t=0, so at now=24h the span
      // check passes.
      await recordAttempt(flagStore, 3, GATEWAY_A, 0);
      for (let i = 1; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS; i++) {
        await recordAttempt(
          flagStore,
          3,
          GATEWAY_A,
          CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
        );
      }

      // Spy on the cidProducer callback — each publish iteration invokes it
      // exactly once. Steelman¹⁹ refactor: acceptCarLoss now calls
      // #publishInner directly (bypassing the public publish() method's
      // shutdown-gate to prevent mid-operation aborts), so spying on
      // layer.publish would observe zero calls. Spying on cidProducer is a
      // black-box behavioral assertion — independent of which public method
      // is on the call stack.
      const cid = cidForBytes(new TextEncoder().encode('car-loss-republish'));
      const cidProducer = vi.fn(async () => cid.bytes);

      const result = await layer.acceptCarLoss(3, cidProducer);

      // H7 step 4: republish invoked exactly once — NOT zero (no "skip
      // republish" shortcut), NOT more than once (no accidental retry loop).
      // Exactly one cidProducer call proves a single publish iteration.
      expect(cidProducer).toHaveBeenCalledTimes(1);

      // And the fake aggregator observed two submitCommitment calls (one per
      // side A/B of the republished pointer) — proves the full §7.3 submit
      // flow ran, not a stubbed no-op.
      expect(fakeAggregator.submitCalls).toBe(2);

      // PublishResult shape sanity check: version advanced (>= 1) and an
      // attempt was consumed. Exact values depend on reconcile internals,
      // but attemptsUsed must be >= 1 for a non-trivial publish.
      expect(result.version).toBeGreaterThanOrEqual(1);
      expect(result.attemptsUsed).toBeGreaterThanOrEqual(1);
    });
  });

  // ── G7: successful acceptCarLoss clears the ledger for that version ──────

  describe('G7 — successful acceptCarLoss clears CAR-loss ledger for version', () => {
    it('after success, getAttempts(v) returns empty — stale entries purged', async () => {
      setOverridesPermitted();
      const { layer, flagStore } = await buildLayer({
        config: { allowOperatorOverrides: true },
      });

      // Pre-populate the ledger for v=4 to satisfy H7.
      await recordAttempt(flagStore, 4, GATEWAY_A, 0);
      for (let i = 1; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS; i++) {
        await recordAttempt(
          flagStore,
          4,
          GATEWAY_A,
          CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
        );
      }
      // Sanity: ledger non-empty before acceptCarLoss.
      expect((await getAttempts(flagStore, 4)).length).toBe(
        CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS,
      );

      const cid = cidForBytes(new TextEncoder().encode('car-loss-clear'));
      await layer.acceptCarLoss(4, async () => cid.bytes);

      // Ledger fully cleared for v=4 — leaves a clean slate for subsequent
      // recovery cycles at higher versions.
      const attemptsAfter = await getAttempts(flagStore, 4);
      expect(attemptsAfter).toEqual([]);
    });

    it('clearAttempts for v=4 does NOT touch a concurrent v=5 ledger', async () => {
      // Belt-and-braces: the clear step must be scoped to the exact version
      // passed to acceptCarLoss. A bug that called clearAttempts(anyV) would
      // wipe parallel recovery state.
      setOverridesPermitted();
      const { layer, flagStore } = await buildLayer({
        config: { allowOperatorOverrides: true },
      });

      // v=4 ledger: satisfies H7.
      await recordAttempt(flagStore, 4, GATEWAY_A, 0);
      for (let i = 1; i < CAR_FETCH_PERSISTENT_RETRY_ATTEMPTS; i++) {
        await recordAttempt(
          flagStore,
          4,
          GATEWAY_A,
          CAR_FETCH_PERSISTENT_TOTAL_DURATION_MS,
        );
      }
      // v=5 ledger: a few unrelated in-flight attempts.
      await recordAttempt(flagStore, 5, GATEWAY_B, 1000);
      await recordAttempt(flagStore, 5, GATEWAY_B, 2000);

      const cid = cidForBytes(new TextEncoder().encode('car-loss-scoped'));
      await layer.acceptCarLoss(4, async () => cid.bytes);

      // v=4 cleared, v=5 intact.
      expect(await getAttempts(flagStore, 4)).toEqual([]);
      expect((await getAttempts(flagStore, 5)).length).toBe(2);

      // Explicit cleanup — no cross-test bleed from the shared storage key space.
      await clearAttempts(flagStore, 5);
    });
  });
});
