/**
 * Category-I integration tests for the aggregator pointer layer
 * (SPEC §10.8 corrupt-version-streak + §13 acceptCorruptStreak operator override).
 *
 * These tests sit at the INTEGRATION layer — they wire
 * `findLatestValidVersion` (discover-algorithm) and
 * `ProfilePointerLayer.acceptCorruptStreak` end-to-end against a
 * per-version-routing mock aggregator + in-memory FlagStore / mutex.
 *
 * They complement the unit tests in
 * `tests/unit/profile/pointer/discover-algorithm.test.ts` (whose own
 * comment at line 182 explicitly defers CORRUPT_STREAK coverage to a
 * per-version-routed integration mock — this file is that coverage).
 *
 * Coverage (tasks #I1–I4):
 *
 *   I1  discoverLatestVersion hits CORRUPT_STREAK when the Phase-3
 *       walkback exhausts `DISCOVERY_CORRUPT_WALKBACK` consecutive
 *       SEMANTICALLY_INVALID versions without finding a VALID one.
 *
 *   I2  `acceptCorruptStreak` throws CAPABILITY_DENIED when the layer
 *       was constructed without `allowOperatorOverrides: true`.
 *
 *   I3  `acceptCorruptStreak(walkbackLimit)` caps the returned
 *       `walkbackUsed` at 4096 per SPEC §13 safety ceiling, even when
 *       callers pass values wildly above the cap.
 *
 *   I4  After `acceptCorruptStreak` raises the ceiling, passing the
 *       raised limit to the next `discoverLatestVersion(walkbackLimit)`
 *       call picks up with the raised limit for a single call —
 *       recovery now returns `{ validV: 0, includedV: <high> }` instead
 *       of throwing CORRUPT_STREAK.
 *
 * Mock strategy — per-version routing
 * -----------------------------------
 *
 * The real probe path derives a distinct RequestId for every
 * (side, version) pair via `buildRequestIds` (aggregator-probe.ts
 * §__internal). Our mock pre-computes these requestIds for all
 * versions we want to route and then looks up the correct response on
 * `getInclusionProof(requestId)` calls. This lets us control exactly
 * which versions are "included" (→ Phase-1/2 probe returns true) and
 * which are "corrupt" (→ Phase-3 classifyVersion returns
 * SEMANTICALLY_INVALID).
 *
 * To force SEMANTICALLY_INVALID without faking proof verification
 * failure, the mock injects a `decodeCid` callback that returns
 * `{ ok: false }` for every version above the walkback start. Phase 1+2
 * never reach the decoder (they only call `probeVersion`), but Phase 3
 * does — and the decoder's semantic-invalid verdict drives the streak.
 */

import { describe, it, expect } from 'vitest';

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';
import { InclusionProofResponse } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProofResponse.js';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';

import {
  AggregatorPointerErrorCode,
  DISCOVERY_CORRUPT_WALKBACK,
  DURABLE_STORAGE,
  FlagStore,
  ProfilePointerLayer,
  buildPointerSigner,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  findLatestValidVersion,
  type CarFetcher,
  type CidDecoder,
  type FetchAndJoinCallback,
  type PointerKeyMaterial,
  type PointerSigner,
  type PointerVersion,
} from '../../../extensions/uxf/profile/aggregator-pointer/index.js';
import { __internal as probeInternal } from '../../../extensions/uxf/profile/aggregator-pointer/aggregator-probe.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const WALLET_SEED = new Uint8Array(32).fill(0x5c);

async function buildIdentity(): Promise<{
  keyMaterial: PointerKeyMaterial;
  signer: PointerSigner;
}> {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

/** In-memory DurableStorageProvider — same shape as other integration tests. */
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

/** In-memory mutex — no fsync, just reentrancy serialization. */
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

function fakeTrustBase(epoch: bigint = 1n): RootTrustBase {
  return { epoch } as RootTrustBase;
}

function makeProof(status: InclusionProofVerificationStatus): InclusionProof {
  // Include both sides' worth of 32-byte txHash data so runDecodePhases'
  // XOR step sees a full 32-byte ct. CID decoding is delegated to the
  // injected decoder below.
  return {
    verify: async () => status,
    transactionHash: {
      data: new Uint8Array(32).fill(0x7e),
      imprint: new Uint8Array(34),
    },
    unicityCertificate: {
      unicitySeal: { epoch: 1n },
      inputRecord: { epoch: 1n },
    },
  } as unknown as InclusionProof;
}

/**
 * Per-version-routing aggregator mock.
 *
 * Callers describe a `vTrue` — versions [1..vTrue] are "included" (proof
 * verify OK on both sides); versions [vTrue+1..] are "not included"
 * (PATH_NOT_INCLUDED). The mock precomputes requestIds for versions
 * 1..maxV so `getInclusionProof(requestId)` can route correctly.
 */
async function makeVersionRoutingAggregator(
  vTrue: number,
  maxV: number,
  keyMaterial: PointerKeyMaterial,
  signer: PointerSigner,
): Promise<{
  client: AggregatorClient;
  callLog: Array<{ version: number; included: boolean }>;
  unknownRequestCount: () => number;
}> {
  // Precompute: requestId.toString() → { version, included }
  const idToMeta = new Map<string, { version: number; included: boolean }>();
  for (let v = 1; v <= maxV; v++) {
    const { reqA, reqB } = await probeInternal.buildRequestIds(keyMaterial, signer, v);
    const included = v <= vTrue;
    idToMeta.set(reqA.toString(), { version: v, included });
    idToMeta.set(reqB.toString(), { version: v, included });
  }

  const callLog: Array<{ version: number; included: boolean }> = [];
  let unknownRequests = 0;

  const client = {
    getInclusionProof: async (requestId: RequestId) => {
      const meta = idToMeta.get(requestId.toString());
      if (!meta) {
        // Probe asked for a version outside our pre-seeded range.
        // In Phase 1 this can happen when expansion overshoots maxV — we
        // answer PATH_NOT_INCLUDED so the binary-search lo/hi converges
        // inside the instrumented range.
        unknownRequests += 1;
        return new InclusionProofResponse(
          makeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED),
        );
      }
      callLog.push({ version: meta.version, included: meta.included });
      return new InclusionProofResponse(
        makeProof(
          meta.included
            ? InclusionProofVerificationStatus.OK
            : InclusionProofVerificationStatus.PATH_NOT_INCLUDED,
        ),
      );
    },
  } as unknown as AggregatorClient;

  return { client, callLog, unknownRequestCount: () => unknownRequests };
}

/**
 * CidDecoder that always rejects — Phase 3 `classifyVersion` sees both
 * sides OK but the decoder says "corrupt", yielding SEMANTICALLY_INVALID.
 */
const alwaysCorruptDecoder: CidDecoder = () => ({ ok: false });

/** CarFetcher stub — never reached when the decoder already rejects. */
const unreachableFetcher: CarFetcher = async () => ({ ok: true });

/** Build a ProfilePointerLayer wired up for acceptCorruptStreak tests. */
async function buildLayer(opts: {
  aggregatorClient: AggregatorClient;
  keyMaterial: PointerKeyMaterial;
  signer: PointerSigner;
  allowOperatorOverrides?: boolean;
}): Promise<ProfilePointerLayer> {
  const storage = makeDurableStore();
  const flagStore = FlagStore.create(storage as never, opts.signer.signingPubKeyHex);
  const mutex = makeInMemoryMutex();
  const trustBase = fakeTrustBase();

  const fetchAndJoin: FetchAndJoinCallback = async () => {
    throw new Error('fetchAndJoin should not fire during discovery-only tests');
  };

  return new ProfilePointerLayer({
    keyMaterial: opts.keyMaterial,
    signer: opts.signer,
    aggregatorClient: opts.aggregatorClient,
    trustBase,
    flagStore,
    mutex,
    decodeCid: alwaysCorruptDecoder,
    fetchCar: unreachableFetcher,
    fetchAndJoin,
    readLocalVersion: async () => 0 as PointerVersion,
    persistLocalVersion: async () => {},
    resolveRemoteCid: async () => {
      throw new Error('resolveRemoteCid should not fire during discovery-only tests');
    },
    config: {
      allowOperatorOverrides: opts.allowOperatorOverrides,
    },
  });
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('Pointer Category-I integration — §10.8 corrupt-streak + §13 acceptCorruptStreak', () => {
  // ── I1: discoverLatestVersion hits CORRUPT_STREAK ─────────────────────────

  describe('I1 — CORRUPT_STREAK after Phase-3 walkback exhaustion', () => {
    it('findLatestValidVersion throws CORRUPT_STREAK when >DISCOVERY_CORRUPT_WALKBACK consecutive SEMANTICALLY_INVALID versions are encountered', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      // vTrue = 128: Phase 1 exponential expansion finds true-through-128,
      // Phase 2 binary-searches to includedV = 128. Phase 3 walks back
      // through SEMANTICALLY_INVALID versions (the decoder rejects every
      // one). The default walkback ceiling is DISCOVERY_CORRUPT_WALKBACK
      // (=64), so the walk bails out at candidate=64 with
      // `walked === walkbackLimit` — candidate is NOT 0, so the
      // post-loop branch raises CORRUPT_STREAK. The point of using 128
      // (instead of, say, 65) is to give ourselves headroom so a minor
      // off-by-one in walkback bookkeeping still surfaces CORRUPT_STREAK
      // rather than silently bottoming out at validV=0.
      const vTrue = 128;
      const maxV = 1024; // covers Phase 1 expansion up to 512 (next is 1024).

      const { client } = await makeVersionRoutingAggregator(vTrue, maxV, keyMaterial, signer);
      const trustBase = fakeTrustBase();

      await expect(
        findLatestValidVersion({
          currentLocalVersion: 0 as PointerVersion,
          keyMaterial,
          signer,
          aggregatorClient: client,
          trustBase,
          decodeCid: alwaysCorruptDecoder,
          fetchCar: unreachableFetcher,
        }),
      ).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.CORRUPT_STREAK,
      });
    });

    it('CORRUPT_STREAK error carries includedV, walkbackLimit, walkedSoFar diagnostics', async () => {
      // Regression check: the thrown error is the carrier for operator UI
      // context (SPEC §10.8). If any of these details regress, the §13
      // acceptCorruptStreak override flow loses its diagnostic surface.
      const { keyMaterial, signer } = await buildIdentity();
      const vTrue = 128;
      const maxV = 1024;

      const { client } = await makeVersionRoutingAggregator(vTrue, maxV, keyMaterial, signer);
      const trustBase = fakeTrustBase();

      let caught: unknown = null;
      try {
        await findLatestValidVersion({
          currentLocalVersion: 0 as PointerVersion,
          keyMaterial,
          signer,
          aggregatorClient: client,
          trustBase,
          decodeCid: alwaysCorruptDecoder,
          fetchCar: unreachableFetcher,
        });
      } catch (e) {
        caught = e;
      }

      const details = (caught as { details?: Record<string, unknown> }).details;
      expect(details).toBeDefined();
      if (!details) return;
      expect(details['includedV']).toBe(vTrue);
      expect(details['walkbackLimit']).toBe(DISCOVERY_CORRUPT_WALKBACK);
      // Walked at least the walkback limit steps before bailing — if this
      // regresses to a smaller number, the loop exited too early.
      expect(typeof details['walkedSoFar']).toBe('number');
      expect(details['walkedSoFar']).toBeGreaterThanOrEqual(DISCOVERY_CORRUPT_WALKBACK);
    });
  });

  // ── I2: acceptCorruptStreak CAPABILITY_DENIED when overrides disabled ────

  describe('I2 — CAPABILITY_DENIED when overrides disabled', () => {
    it('acceptCorruptStreak() throws CAPABILITY_DENIED without allowOperatorOverrides', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      // Dummy aggregator — acceptCorruptStreak must fail the capability
      // check BEFORE any network interaction. If this test ever makes a
      // real getInclusionProof call, we'll know something is wrong.
      const client = {
        getInclusionProof: async () => {
          throw new Error(
            'acceptCorruptStreak must reject before reaching the aggregator',
          );
        },
      } as unknown as AggregatorClient;

      const layer = await buildLayer({
        aggregatorClient: client,
        keyMaterial,
        signer,
        // allowOperatorOverrides intentionally omitted (undefined → false).
      });

      await expect(layer.acceptCorruptStreak(128)).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.CAPABILITY_DENIED,
      });
    });

    it('default-constructed layer (no config) also rejects acceptCorruptStreak()', async () => {
      // Complementary assertion: passing an entirely empty config (no
      // operator-override field at all) MUST behave identically to
      // explicit `allowOperatorOverrides: false`. This prevents a subtle
      // regression where an `if (config.allowOperatorOverrides !== true)`
      // check flips to a looser `=== false` check.
      const { keyMaterial, signer } = await buildIdentity();
      const client = {
        getInclusionProof: async () => {
          throw new Error('unexpected probe during capability-gated path');
        },
      } as unknown as AggregatorClient;

      const layer = await buildLayer({
        aggregatorClient: client,
        keyMaterial,
        signer,
      });

      await expect(layer.acceptCorruptStreak()).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.CAPABILITY_DENIED,
      });
    });
  });

  // ── I3: acceptCorruptStreak caps walkbackUsed at 4096 ────────────────────

  describe('I3 — walkbackUsed capped at 4096 (SPEC §13 safety ceiling)', () => {
    // This block needs allowOperatorOverrides: true to reach the body of
    // acceptCorruptStreak. That in turn requires SPHERE_ALLOW_OVERRIDES=1
    // in the environment. We set it around each test and restore after.
    const saveEnv = (): (() => void) => {
      const prev = process.env['SPHERE_ALLOW_OVERRIDES'];
      process.env['SPHERE_ALLOW_OVERRIDES'] = '1';
      return () => {
        if (prev === undefined) delete process.env['SPHERE_ALLOW_OVERRIDES'];
        else process.env['SPHERE_ALLOW_OVERRIDES'] = prev;
      };
    };

    it('returns walkbackUsed=4096 when caller requests 5000 (above ceiling)', async () => {
      const restore = saveEnv();
      try {
        const { keyMaterial, signer } = await buildIdentity();
        const client = {
          getInclusionProof: async () => {
            throw new Error(
              'acceptCorruptStreak should not touch the aggregator — it only raises the ceiling',
            );
          },
        } as unknown as AggregatorClient;

        const layer = await buildLayer({
          aggregatorClient: client,
          keyMaterial,
          signer,
          allowOperatorOverrides: true,
        });

        const result = await layer.acceptCorruptStreak(5000);
        expect(result.walkbackUsed).toBe(4096);
      } finally {
        restore();
      }
    });

    it('returns walkbackUsed=4096 for the default (no-arg) invocation', async () => {
      // SPEC §13: the default argument is 4096, so no-arg invocation is
      // exactly at the ceiling. Guards against a regression where the
      // default drops to DISCOVERY_CORRUPT_WALKBACK (which would make the
      // override a no-op on default settings).
      const restore = saveEnv();
      try {
        const { keyMaterial, signer } = await buildIdentity();
        const client = {
          getInclusionProof: async () => {
            throw new Error('unexpected probe during acceptCorruptStreak');
          },
        } as unknown as AggregatorClient;

        const layer = await buildLayer({
          aggregatorClient: client,
          keyMaterial,
          signer,
          allowOperatorOverrides: true,
        });

        const result = await layer.acceptCorruptStreak();
        expect(result.walkbackUsed).toBe(4096);
      } finally {
        restore();
      }
    });

    it('returns walkbackUsed=<input> when caller requests a value ≤ 4096', async () => {
      // The cap is Math.min(walkbackLimit, 4096) — values at or below the
      // ceiling pass through unchanged. This keeps the override useful
      // for operators who want a targeted, smaller bump (say, 128) rather
      // than the full-fat 4096 safety ceiling.
      const restore = saveEnv();
      try {
        const { keyMaterial, signer } = await buildIdentity();
        const client = {
          getInclusionProof: async () => {
            throw new Error('unexpected probe during acceptCorruptStreak');
          },
        } as unknown as AggregatorClient;

        const layer = await buildLayer({
          aggregatorClient: client,
          keyMaterial,
          signer,
          allowOperatorOverrides: true,
        });

        const result = await layer.acceptCorruptStreak(256);
        expect(result.walkbackUsed).toBe(256);
      } finally {
        restore();
      }
    });
  });

  // ── I4: raised ceiling picked up by next discoverLatestVersion call ─────

  describe('I4 — next discoverLatestVersion(walkbackLimit) picks up raised limit', () => {
    const saveEnv = (): (() => void) => {
      const prev = process.env['SPHERE_ALLOW_OVERRIDES'];
      process.env['SPHERE_ALLOW_OVERRIDES'] = '1';
      return () => {
        if (prev === undefined) delete process.env['SPHERE_ALLOW_OVERRIDES'];
        else process.env['SPHERE_ALLOW_OVERRIDES'] = prev;
      };
    };

    it('with raised limit, discoverLatestVersion bottoms out at validV=0 instead of throwing CORRUPT_STREAK', async () => {
      // Setup identical to I1: vTrue=128, all versions corrupt.
      //
      // Default call (walkbackLimit omitted) → 64-step walkback, bails
      // with CORRUPT_STREAK at candidate=64. We verify that first.
      //
      // Then acceptCorruptStreak(200) raises the ceiling. The very next
      // discoverLatestVersion(200) call walks back 128 steps (from 128
      // down to 0), hits the `candidate === 0` exit branch in
      // findLatestValidVersion, and returns { validV: 0, includedV: 128 }.
      //
      // This validates the entire §13 override flow: the raised limit
      // actually threads through to discover-algorithm and changes the
      // terminal behavior from throw → return.
      const restore = saveEnv();
      try {
        const { keyMaterial, signer } = await buildIdentity();
        const vTrue = 128;
        const maxV = 1024;

        const { client } = await makeVersionRoutingAggregator(
          vTrue,
          maxV,
          keyMaterial,
          signer,
        );

        const layer = await buildLayer({
          aggregatorClient: client,
          keyMaterial,
          signer,
          allowOperatorOverrides: true,
        });

        // First: default call throws CORRUPT_STREAK (baseline for this
        // fixture). This is the condition §10.8 surfaces to the UI so the
        // operator can decide whether to invoke acceptCorruptStreak.
        await expect(layer.discoverLatestVersion()).rejects.toMatchObject({
          code: AggregatorPointerErrorCode.CORRUPT_STREAK,
        });

        // Operator invokes the override with a limit sized to safely walk
        // back past the entire corrupt streak.
        const override = await layer.acceptCorruptStreak(200);
        expect(override.walkbackUsed).toBe(200);

        // Next discovery call, with the raised limit, succeeds.
        const result = await layer.discoverLatestVersion(override.walkbackUsed);
        expect(result.validV).toBe(0);
        expect(result.includedV).toBe(vTrue);
      } finally {
        restore();
      }
    });

    it('raised ceiling only applies to the single call it is passed to — next default-arg call throws again', async () => {
      // SPEC §13 contract: the override is SINGLE-SHOT. If the caller
      // doesn't re-pass walkbackLimit on the next call, the default
      // (DISCOVERY_CORRUPT_WALKBACK) comes back into effect. This test
      // guards against a regression where the ceiling becomes sticky on
      // the layer instance — which would silently relax a safety invariant
      // across subsequent unrelated recovery attempts.
      const restore = saveEnv();
      try {
        const { keyMaterial, signer } = await buildIdentity();
        const vTrue = 128;
        const maxV = 1024;

        const { client } = await makeVersionRoutingAggregator(
          vTrue,
          maxV,
          keyMaterial,
          signer,
        );

        const layer = await buildLayer({
          aggregatorClient: client,
          keyMaterial,
          signer,
          allowOperatorOverrides: true,
        });

        // First call with raised limit succeeds.
        const override = await layer.acceptCorruptStreak(200);
        const firstResult = await layer.discoverLatestVersion(override.walkbackUsed);
        expect(firstResult.validV).toBe(0);

        // Next call with NO walkbackLimit arg goes back to the default —
        // and throws CORRUPT_STREAK again. The raised ceiling did NOT
        // persist on the layer.
        await expect(layer.discoverLatestVersion()).rejects.toMatchObject({
          code: AggregatorPointerErrorCode.CORRUPT_STREAK,
        });
      } finally {
        restore();
      }
    });
  });
});
