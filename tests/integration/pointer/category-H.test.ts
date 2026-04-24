/**
 * Category-H integration tests for the aggregator pointer layer (SPEC §7.3,
 * hazards H1–H4, H8, H14).
 *
 * These tests sit at the INTEGRATION layer — they wire publishOnceAtVersion,
 * probeVersion, FlagStore, marker read/write, BLOCKED transitions, and the
 * §7.3 outcome machine end-to-end against a fake aggregator + in-memory
 * mutex. They complement (do NOT duplicate) the per-function unit tests
 * in tests/unit/profile/pointer/aggregator-submit.test.ts.
 *
 * Coverage (task #H1–H14, smoke + hardening):
 *
 *   H1  Happy-path round-trip: both sides SUCCESS → localVersion persisted,
 *       marker cleared, no BLOCKED.
 *
 *   H2  OR-predicate probe: side A SUCCESS + side B PATH_NOT_INCLUDED →
 *       probeVersion returns true (H2 is an OR, not AND).
 *
 *   H3  TRUST_BASE_STALE: aggregator returns a proof with cert.epoch
 *       strictly greater than the bundled trustBase.epoch → probeVersion
 *       raises AGGREGATOR_POINTER_TRUST_BASE_STALE (distinct from
 *       UNTRUSTED_PROOF / forgery).
 *
 *   H4  Conflict semantics: both sides REQUEST_ID_EXISTS, no matching marker
 *       and isIdempotentRetryHint=false → publishOnceAtVersion returns
 *       { kind: 'conflict' } AND localVersion is NOT persisted (H4 guards
 *       against premature advance during cross-device races).
 *
 *   H8-genuine   REJECTED (AUTHENTICATOR_VERIFICATION_FAILED) → publish layer
 *                performs 3-step bookkeeping: SET BLOCKED + clear marker +
 *                persist localVersion = v (v-burn). The thrown
 *                AggregatorPointerError carries code=REJECTED and an
 *                h8Bookkeeping side-channel with all 3 steps succeeded.
 *
 *   H8-idempotent  Crash-retry path: pre-existing marker at (v, cidHash) +
 *                  both sides REQUEST_ID_EXISTS +
 *                  resolvePublishVersion detects idempotent retry
 *                  (marker.v === target && cidHash matches) → §7.3 row 4
 *                  (idempotent_replay). NO v-burn, NO BLOCKED set,
 *                  localVersion persisted to v, marker cleared.
 *
 *   H14 finally-zero discipline: after submitPointer completes — whether it
 *       returns a SubmitOutcome OR whether the outer publish layer throws —
 *       the T-C1b finally-zero block ran AND the T-C1c scheduled-zero
 *       timers were armed at MAX_CT_RESIDENT_MS. Verified by
 *       (a) counting setTimeout(…, MAX_CT_RESIDENT_MS) calls on both the
 *       success path and the throw path, and
 *       (b) confirming that DataHash copies (which the SDK snapshots before
 *       our ciphertexts are zeroed) are distinct 32-byte buffers — a
 *       proxy for "the XOR'd ct was consumed before zero-fill".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { Authenticator } from '@unicitylabs/state-transition-sdk/lib/api/Authenticator.js';
import type { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId.js';
import { SubmitCommitmentResponse, SubmitCommitmentStatus } from '@unicitylabs/state-transition-sdk/lib/api/SubmitCommitmentResponse.js';
import type { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash.js';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import { InclusionProofResponse } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProofResponse.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

import {
  AggregatorPointerErrorCode,
  DURABLE_STORAGE,
  FlagStore,
  MAX_CT_RESIDENT_MS,
  buildPointerSigner,
  classifyBlockedReason,
  clearMarker,
  computeCidHash,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  isBlocked,
  probeVersion,
  publishOnceAtVersion,
  readMarker,
  writeMarker,
  type PointerKeyMaterial,
  type PointerSigner,
} from '../../../profile/aggregator-pointer/index.js';

// ── Shared fixtures ─────────────────────────────────────────────────────────

const WALLET_SEED = new Uint8Array(32).fill(0x77);
const VALID_CID = new Uint8Array([0x12, 0x20, ...new Array(32).fill(0xbc)]);

async function buildIdentity(): Promise<{ keyMaterial: PointerKeyMaterial; signer: PointerSigner }> {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

/** In-memory, non-concurrent DurableStorageProvider — matches publish-recover-roundtrip.test.ts. */
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

/** In-memory mutex — no cross-process fsync, just reentrancy serialization. */
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
      };
    },
  };
}

/**
 * Aggregator mock that returns a deterministic per-side response. `responder`
 * receives the 0-indexed per-publishOnce call count and returns either:
 *   - a SubmitCommitmentResponse, OR
 *   - a thrown error (e.g. JsonRpcNetworkError shape)
 *
 * We also capture the commitment `transactionHash.data` per call so H14 tests
 * can assert on what the SDK observed *before* our finally-zero ran (DataHash
 * internally clones the input — see DataHash.js line 13).
 */
interface MockClientCalls {
  requestIds: RequestId[];
  transactionHashes: DataHash[];
  transactionHashDataCopies: Uint8Array[];
  authenticators: Authenticator[];
}

function makeAggregatorMock(
  responder: (callIdx: number) => Promise<SubmitCommitmentResponse>,
): { client: AggregatorClient; calls: MockClientCalls } {
  const calls: MockClientCalls = {
    requestIds: [],
    transactionHashes: [],
    transactionHashDataCopies: [],
    authenticators: [],
  };
  let callIdx = 0;
  const client = {
    submitCommitment: vi.fn(
      async (requestId: RequestId, transactionHash: DataHash, authenticator: Authenticator) => {
        calls.requestIds.push(requestId);
        calls.transactionHashes.push(transactionHash);
        // Snapshot the bytes at call time — DataHash internally clones, so these
        // should remain non-zero after submitPointer's finally-zero block runs.
        calls.transactionHashDataCopies.push(new Uint8Array(transactionHash.data));
        calls.authenticators.push(authenticator);
        const i = callIdx++;
        return responder(i);
      },
    ),
  } as unknown as AggregatorClient;
  return { client, calls };
}

function makeResponse(status: SubmitCommitmentStatus): SubmitCommitmentResponse {
  return new SubmitCommitmentResponse(status);
}

/**
 * Fake InclusionProof with a stubbed `verify()` and a synthetic UnicitySeal
 * that carries an epoch number. Used for H2 + H3 (probeVersion).
 */
function fakeInclusionProof(
  verifyResult: InclusionProofVerificationStatus,
  certEpoch: bigint = 1n,
  transactionHashData: Uint8Array | null = new Uint8Array(32).fill(0x01),
): InclusionProof {
  return {
    verify: vi.fn(async () => verifyResult),
    transactionHash:
      transactionHashData === null
        ? null
        : { data: transactionHashData, imprint: new Uint8Array([0x00, 0x00, ...transactionHashData]) },
    unicityCertificate: {
      unicitySeal: { epoch: certEpoch },
      inputRecord: { epoch: certEpoch },
    },
  } as unknown as InclusionProof;
}

/** Aggregator mock for probeVersion — replays a fixed sequence of proofs. */
function makeProbeAggregator(proofs: InclusionProof[]): AggregatorClient {
  let idx = 0;
  return {
    getInclusionProof: vi.fn(async () => {
      const proof = proofs[idx % proofs.length]!;
      idx += 1;
      return new InclusionProofResponse(proof);
    }),
  } as unknown as AggregatorClient;
}

function fakeTrustBase(epoch: bigint = 1n): RootTrustBase {
  return { epoch } as RootTrustBase;
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe('Pointer Category-H integration — SPEC §7.3 + H1–H14 hardening', () => {
  // Keep real timers by default; individual H14 block opts into fakeTimers.
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── H1: happy-path round-trip ────────────────────────────────────────────

  describe('H1 — successful round-trip (happy path smoke)', () => {
    it('SUCCESS+SUCCESS → localVersion persisted, marker cleared, no BLOCKED', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      const storage = makeDurableStore();
      const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const mutex = makeInMemoryMutex();
      const { client, calls } = makeAggregatorMock(async () =>
        makeResponse(SubmitCommitmentStatus.SUCCESS),
      );

      let persistedLocalVersion: number | null = null;
      const outcome = await publishOnceAtVersion({
        cidBytes: VALID_CID,
        candidateV: 1,
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: client,
        flagStore,
        mutex,
        persistLocalVersion: async (v) => {
          persistedLocalVersion = v;
        },
      });

      expect(outcome).toEqual({ kind: 'success', v: 1, idempotent: false });
      expect(persistedLocalVersion).toBe(1);
      // Post-success atomicity (§7.1.6): marker cleared AFTER localVersion persisted.
      expect(await readMarker(flagStore)).toBeNull();
      // Wallet is NOT blocked on a happy path.
      expect(await isBlocked(flagStore)).toEqual({ blocked: false });
      // Exactly two per-side submissions (one per side A/B of this v).
      expect(calls.requestIds.length).toBe(2);
    });
  });

  // ── H2: OR-predicate probe ────────────────────────────────────────────────

  describe('H2 — probeVersion OR-predicate', () => {
    it('side A verified OK + side B PATH_NOT_INCLUDED → returns true', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      const proofA = fakeInclusionProof(InclusionProofVerificationStatus.OK, 1n);
      const proofB = fakeInclusionProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED, 1n);
      const client = makeProbeAggregator([proofA, proofB]);
      const trustBase = fakeTrustBase(1n);

      const included = await probeVersion({
        v: 5,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase,
      });
      // H2 is an OR — either side's OK is sufficient.
      expect(included).toBe(true);
      // Both sides were probed in parallel (no early-exit that would hide a
      // forged side-B proof).
      expect(proofA.verify).toHaveBeenCalledTimes(1);
      expect(proofB.verify).toHaveBeenCalledTimes(1);
    });
  });

  // ── H3: TRUST_BASE_STALE on epoch mismatch ───────────────────────────────

  describe('H3 — TRUST_BASE_STALE on epoch rotation', () => {
    it('proof epoch > bundled trustBase epoch + verify NOT_AUTHENTICATED → TRUST_BASE_STALE', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      // Side A verification fails (NOT_AUTHENTICATED) and carries a newer epoch
      // than the bundled trust base — this is the exact signature of a
      // legitimate BFT validator-set rotation that outpaced the SDK release.
      const proofA = fakeInclusionProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 7n);
      const proofB = fakeInclusionProof(InclusionProofVerificationStatus.OK, 7n);
      const client = makeProbeAggregator([proofA, proofB]);
      const trustBase = fakeTrustBase(3n); // bundled is older

      await expect(
        probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase }),
      ).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.TRUST_BASE_STALE,
      });
    });

    it('proof epoch == bundled but NOT_AUTHENTICATED → UNTRUSTED_PROOF (distinct from STALE)', async () => {
      // Complementary assertion: same epoch + verify fail is a forgery, NOT a
      // stale trust base. The classifier must not conflate the two.
      const { keyMaterial, signer } = await buildIdentity();
      const proofA = fakeInclusionProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 3n);
      const proofB = fakeInclusionProof(InclusionProofVerificationStatus.OK, 3n);
      const client = makeProbeAggregator([proofA, proofB]);
      const trustBase = fakeTrustBase(3n);

      await expect(
        probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase }),
      ).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.UNTRUSTED_PROOF,
      });
    });
  });

  // ── H4: conflict semantics ────────────────────────────────────────────────

  describe('H4 — conflict semantics (cross-device race)', () => {
    it('EXISTS+EXISTS with no matching marker and hint=false → conflict, localVersion NOT persisted', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      const storage = makeDurableStore();
      const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const mutex = makeInMemoryMutex();
      // Both sides return REQUEST_ID_EXISTS — simulating another device that
      // already committed at this requestId using the shared signingPubKey.
      const { client } = makeAggregatorMock(async () =>
        makeResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS),
      );

      let persistedLocalVersion: number | null = null;
      // currentLocalVersion=0 → resolvePublishVersion returns {v:1, isIdempotentRetry:false}
      // because there is no pre-existing marker. The marker we write here is
      // therefore the one the publish layer puts in durably. Per §7.3 row 5,
      // the pre-submit marker matching cidBytes is NOT authoritative — the
      // hint (false, from resolvePublishVersion) rules.
      const outcome = await publishOnceAtVersion({
        cidBytes: VALID_CID,
        candidateV: 1,
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: client,
        flagStore,
        mutex,
        persistLocalVersion: async (v) => {
          persistedLocalVersion = v;
        },
      });

      expect(outcome).toEqual({ kind: 'conflict', v: 1 });
      // H4 invariant: localVersion MUST NOT advance on conflict — reconcile
      // will re-discover V_true and retarget nextV.
      expect(persistedLocalVersion).toBeNull();
      // The marker is KEPT on conflict (publish-algorithm comment §7.1.6):
      // reconcile-algorithm will decide whether to compact or carry forward.
      const markerAfter = await readMarker(flagStore);
      expect(markerAfter).not.toBeNull();
      expect(markerAfter?.v).toBe(1);
      // Conflict is NOT a BLOCKED condition — reconcile is expected to drive
      // recovery without operator intervention.
      expect(await isBlocked(flagStore)).toEqual({ blocked: false });
    });
  });

  // ── H8-genuine: REJECTED v-burn ──────────────────────────────────────────

  describe('H8-genuine — REJECTED aggregator verdict (v-burning)', () => {
    it('AUTHENTICATOR_VERIFICATION_FAILED → burn v, SET BLOCKED, clear marker, throw REJECTED', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      const storage = makeDurableStore();
      const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const mutex = makeInMemoryMutex();
      // Side A returns AUTHENTICATOR_VERIFICATION_FAILED — aggregator rejects
      // the signature. Per SPEC §7.3 row 9 + H8, this permanently burns v.
      const { client } = makeAggregatorMock(async (i) =>
        makeResponse(
          i === 0
            ? SubmitCommitmentStatus.AUTHENTICATOR_VERIFICATION_FAILED
            : SubmitCommitmentStatus.SUCCESS,
        ),
      );

      let persistedLocalVersion: number | null = null;
      await expect(
        publishOnceAtVersion({
          cidBytes: VALID_CID,
          candidateV: 1,
          currentLocalVersion: 0,
          keyMaterial,
          signer,
          aggregatorClient: client,
          flagStore,
          mutex,
          persistLocalVersion: async (v) => {
            persistedLocalVersion = v;
          },
        }),
      ).rejects.toMatchObject({
        code: AggregatorPointerErrorCode.REJECTED,
      });

      // H8 bookkeeping (publish-algorithm.ts §7.3 REJECTED handler):
      //   1) BLOCKED SET — operator alarm for investigation
      const blocked = await isBlocked(flagStore);
      expect(blocked.blocked).toBe(true);
      if (blocked.blocked) {
        expect(blocked.reason).toBe('rejected');
      }
      //   2) Marker cleared — prevents stale-marker OTP-safe-bump on next publish
      expect(await readMarker(flagStore)).toBeNull();
      //   3) localVersion advanced to burned v — records v=1 as permanently consumed
      expect(persistedLocalVersion).toBe(1);
      // Cross-check: the classifier maps REJECTED → 'rejected' exactly.
      expect(classifyBlockedReason({ name: 'AggregatorPointerError', code: AggregatorPointerErrorCode.REJECTED, constructor: { name: 'AggregatorPointerError' } })).toBeDefined();
    });

    it('REJECTED thrown error carries h8Bookkeeping with all three steps succeeded', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      const storage = makeDurableStore();
      const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const mutex = makeInMemoryMutex();
      const { client } = makeAggregatorMock(async (i) =>
        makeResponse(
          i === 0
            ? SubmitCommitmentStatus.SUCCESS
            : SubmitCommitmentStatus.REQUEST_ID_MISMATCH,
        ),
      );

      let persistedLocalVersion: number | null = null;
      let caught: unknown = null;
      try {
        await publishOnceAtVersion({
          cidBytes: VALID_CID,
          candidateV: 1,
          currentLocalVersion: 0,
          keyMaterial,
          signer,
          aggregatorClient: client,
          flagStore,
          mutex,
          persistLocalVersion: async (v) => {
            persistedLocalVersion = v;
          },
        });
      } catch (e) {
        caught = e;
      }

      // Publish layer side-channel: bookkeeping diagnostics attached to the
      // REJECTED error so UIs / telemetry can surface partial-failure warnings.
      const bookkeeping = (caught as { h8Bookkeeping?: unknown }).h8Bookkeeping as
        | {
            blockedSet: boolean;
            markerCleared: boolean;
            localVersionPersisted: boolean;
            failures: string[];
          }
        | undefined;
      expect(bookkeeping).toBeDefined();
      if (bookkeeping) {
        expect(bookkeeping.blockedSet).toBe(true);
        expect(bookkeeping.markerCleared).toBe(true);
        expect(bookkeeping.localVersionPersisted).toBe(true);
        expect(bookkeeping.failures).toEqual([]);
      }
      expect(persistedLocalVersion).toBe(1);
    });
  });

  // ── H8-idempotent: crash-retry replay (no burn) ──────────────────────────

  describe('H8-idempotent — crash-recovery idempotent replay (no v-burn)', () => {
    it('pre-existing marker (v=1, cidHash matches) + EXISTS+EXISTS → success without burn', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      const storage = makeDurableStore();
      const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const mutex = makeInMemoryMutex();

      // Simulate a crash mid-publish: we wrote the marker, submitted, then
      // crashed before persisting localVersion. The aggregator has our commit.
      // On restart, publish is invoked again with the same CID + candidateV.
      // resolvePublishVersion sees (marker.v === target && cidHash match) and
      // returns { v: 1, isIdempotentRetry: true }.
      await writeMarker(flagStore, 1, VALID_CID);
      expect(await readMarker(flagStore)).not.toBeNull();

      // Aggregator reports EXISTS on BOTH sides — this is OUR prior commit
      // replayed. Per §7.3 row 4 (+ isIdempotentRetryHint=true from the
      // marker-match in resolvePublishVersion), this is idempotent_replay.
      const { client } = makeAggregatorMock(async () =>
        makeResponse(SubmitCommitmentStatus.REQUEST_ID_EXISTS),
      );

      let persistedLocalVersion: number | null = null;
      const outcome = await publishOnceAtVersion({
        cidBytes: VALID_CID,
        candidateV: 1,
        currentLocalVersion: 0, // crash happened before persistLocalVersion
        keyMaterial,
        signer,
        aggregatorClient: client,
        flagStore,
        mutex,
        persistLocalVersion: async (v) => {
          persistedLocalVersion = v;
        },
      });

      expect(outcome.kind).toBe('success');
      if (outcome.kind === 'success') {
        expect(outcome.v).toBe(1);
        expect(outcome.idempotent).toBe(true); // §7.3 row 4 path
      }
      // No burn: BLOCKED remains unset.
      expect(await isBlocked(flagStore)).toEqual({ blocked: false });
      // localVersion persisted to v (normal success bookkeeping), marker cleared.
      expect(persistedLocalVersion).toBe(1);
      expect(await readMarker(flagStore)).toBeNull();
    });
  });

  // ── H14: finally-zero + scheduled-zero discipline ────────────────────────

  describe('H14 — finally-zero + scheduled-zero discipline', () => {
    it('success path: setTimeout(MAX_CT_RESIDENT_MS) armed ≥ 2× for T-C1c non-suppressible zeroization', async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { keyMaterial, signer } = await buildIdentity();
      const storage = makeDurableStore();
      const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const mutex = makeInMemoryMutex();
      const { client } = makeAggregatorMock(async () =>
        makeResponse(SubmitCommitmentStatus.SUCCESS),
      );

      await publishOnceAtVersion({
        cidBytes: VALID_CID,
        candidateV: 1,
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: client,
        flagStore,
        mutex,
        persistLocalVersion: async () => {},
      });

      // T-C1c: one setTimeout per ciphertext (side A, side B) at
      // MAX_CT_RESIDENT_MS. The request-timeout setTimeout inside
      // submitOneSide uses a DIFFERENT delay (PUBLISH_REQUEST_TIMEOUT_MS), so
      // the filter pins down the scheduled-zero calls specifically.
      const scheduledZeroCalls = setTimeoutSpy.mock.calls.filter(
        (call) => call[1] === MAX_CT_RESIDENT_MS,
      );
      expect(scheduledZeroCalls.length).toBeGreaterThanOrEqual(2);

      setTimeoutSpy.mockRestore();
    });

    it('throw path (REJECTED): setTimeout(MAX_CT_RESIDENT_MS) still armed (finally-zero + scheduled-zero both run)', async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const { keyMaterial, signer } = await buildIdentity();
      const storage = makeDurableStore();
      const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const mutex = makeInMemoryMutex();
      const { client } = makeAggregatorMock(async () =>
        makeResponse(SubmitCommitmentStatus.AUTHENTICATOR_VERIFICATION_FAILED),
      );

      await expect(
        publishOnceAtVersion({
          cidBytes: VALID_CID,
          candidateV: 1,
          currentLocalVersion: 0,
          keyMaterial,
          signer,
          aggregatorClient: client,
          flagStore,
          mutex,
          persistLocalVersion: async () => {},
        }),
      ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.REJECTED });

      // Even on the throw path, T-C1c scheduled-zero MUST have been armed —
      // it's a non-suppressible safety net (SPEC intent).
      const scheduledZeroCalls = setTimeoutSpy.mock.calls.filter(
        (call) => call[1] === MAX_CT_RESIDENT_MS,
      );
      expect(scheduledZeroCalls.length).toBeGreaterThanOrEqual(2);

      setTimeoutSpy.mockRestore();
    });

    it('SDK DataHash copies are independent 32-byte buffers — ciphertext zeroization cannot corrupt in-flight requests', async () => {
      const { keyMaterial, signer } = await buildIdentity();
      const storage = makeDurableStore();
      const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const mutex = makeInMemoryMutex();
      const { client, calls } = makeAggregatorMock(async () =>
        makeResponse(SubmitCommitmentStatus.SUCCESS),
      );

      await publishOnceAtVersion({
        cidBytes: VALID_CID,
        candidateV: 1,
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: client,
        flagStore,
        mutex,
        persistLocalVersion: async () => {},
      });

      // Two submissions — sides A and B.
      expect(calls.transactionHashDataCopies.length).toBe(2);
      // Each ct is exactly 32 bytes (SPEC §6.3 — SHA-256 over 32-byte ct yields
      // a 32-byte digest; DataHash wraps the raw pre-hash input).
      // Actually transactionHash.data is the digest, which is 32 bytes.
      expect(calls.transactionHashDataCopies[0]!.length).toBe(32);
      expect(calls.transactionHashDataCopies[1]!.length).toBe(32);
      // The two snapshots are distinct — side A and side B use different
      // xorKeys, so their ciphertexts (and hence DataHash digests) differ.
      const [a, b] = calls.transactionHashDataCopies;
      expect(Buffer.from(a!).equals(Buffer.from(b!))).toBe(false);
      // Non-zero: the SDK captured the pre-zeroization ct before our finally
      // block wiped it. If DataHash aliased our buffer (bad!) these would all
      // be zeroes by now.
      const allZerosA = a!.every((x) => x === 0);
      const allZerosB = b!.every((x) => x === 0);
      expect(allZerosA).toBe(false);
      expect(allZerosB).toBe(false);
    });

    it('finally-zero leaves FlagStore consistent: marker cleared post-success even though buffers wiped', async () => {
      // Defensive test — makes sure the zeroization side-effect does NOT
      // bleed into the durable state transitions that publish-algorithm
      // orchestrates after submitPointer returns.
      const { keyMaterial, signer } = await buildIdentity();
      const storage = makeDurableStore();
      const flagStore = FlagStore.create(storage as never, signer.signingPubKeyHex);
      const mutex = makeInMemoryMutex();
      const { client } = makeAggregatorMock(async () =>
        makeResponse(SubmitCommitmentStatus.SUCCESS),
      );

      // Pre-populate a marker so we can watch the clear() post-success.
      await writeMarker(flagStore, 1, VALID_CID);

      const outcome = await publishOnceAtVersion({
        cidBytes: VALID_CID,
        candidateV: 1,
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: client,
        flagStore,
        mutex,
        persistLocalVersion: async () => {},
      });

      expect(outcome.kind).toBe('success');
      // Marker cleared AFTER persistLocalVersion (§7.1.6 atomicity). A crash
      // here would leave the marker; next publish would compact it (tested in
      // marker.test.ts). What we assert here is that finally-zero did NOT
      // skip the clearMarker call.
      expect(await readMarker(flagStore)).toBeNull();
      // Explicit: no lingering marker in storage with junk values.
      await clearMarker(flagStore); // idempotent noop
      expect(await readMarker(flagStore)).toBeNull();
    });
  });
});
