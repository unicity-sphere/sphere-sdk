/**
 * Walkback `EXISTS-BUT-UNFETCHABLE` semantic — Phase 3 skip-past behavior.
 *
 * Regression coverage for the user-reported failure where a wallet with
 * a broken-but-existing aggregator pointer (proof on-chain but CAR
 * unreachable on every IPFS gateway) blocked cold-start recovery and
 * conflict-driven publish-discovery. The legacy SPEC-strict behavior
 * threw `CAR_UNAVAILABLE` from Phase 3 walkback, which manifested as a
 * 30 s `awaitNextFlush` timeout during legacy → Profile token-storage
 * migration.
 *
 * The fix changes Phase 3 walkback's default policy: a
 * `TRANSIENT_UNAVAILABLE` slot (proof authentic, CID decoded, CAR
 * unfetchable) is now SKIPPED-PAST instead of throwing — Phase 3
 * continues looking for an older fetchable VALID predecessor. The
 * skipped versions are recorded in
 * `DiscoverResult.walkbackUnfetchableSkipped` for operator
 * observability.
 *
 * The legacy SPEC-strict behavior is preserved behind the explicit
 * `skipUnfetchableInWalkback: false` opt-in for callers that still want
 * to invoke the operator-driven `acceptCarLoss(version)` flow.
 *
 * Design rationale + security model documented in
 * `profile/aggregator-pointer/discover-algorithm.ts` (file header).
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
  buildPointerSigner,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  findLatestValidVersion,
  type CarFetcher,
  type CidDecoder,
  type PointerKeyMaterial,
  type PointerSigner,
  type PointerVersion,
} from '../../../profile/aggregator-pointer/index.js';
import { __internal as probeInternal } from '../../../profile/aggregator-pointer/aggregator-probe.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const WALLET_SEED = new Uint8Array(32).fill(0xee);
const VALID_CID = new Uint8Array([0x12, 0x20, ...new Array(32).fill(0xab)]);

async function buildIdentity(): Promise<{
  keyMaterial: PointerKeyMaterial;
  signer: PointerSigner;
}> {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

function fakeTrustBase(epoch: bigint = 1n): RootTrustBase {
  return { epoch } as RootTrustBase;
}

function makeProof(status: InclusionProofVerificationStatus): InclusionProof {
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
 * Versions [1..vTrue] are "included" (proof verify OK both sides);
 * versions above vTrue return PATH_NOT_INCLUDED. We pre-compute
 * requestIds for both sides of every version in [1..maxV].
 */
async function makeVersionRoutingAggregator(
  vTrue: number,
  maxV: number,
  keyMaterial: PointerKeyMaterial,
  signer: PointerSigner,
): Promise<{ client: AggregatorClient }> {
  const idToIncluded = new Map<string, boolean>();
  for (let v = 1; v <= maxV; v++) {
    const { reqA, reqB } = await probeInternal.buildRequestIds(keyMaterial, signer, v);
    const included = v <= vTrue;
    idToIncluded.set(reqA.toString(), included);
    idToIncluded.set(reqB.toString(), included);
  }

  const client = {
    getInclusionProof: async (requestId: RequestId) => {
      const included = idToIncluded.get(requestId.toString());
      const status =
        included === true
          ? InclusionProofVerificationStatus.OK
          : InclusionProofVerificationStatus.PATH_NOT_INCLUDED;
      return new InclusionProofResponse(makeProof(status));
    },
  } as unknown as AggregatorClient;

  return { client };
}

/** Decoder that returns OK for every version with a fixed CID. */
const okDecoder: CidDecoder = () => ({ ok: true, cidBytes: VALID_CID });

/**
 * Build a `CarFetcher` that returns `transient_unavailable` for the
 * specified versions, `ok: true` for everything else.
 *
 * In a real wallet the failure is per-CID, but the decoder above gives
 * every version the SAME CID (`VALID_CID`). To distinguish "the broken
 * version" from "the predecessor that should succeed" we count fetch
 * calls — the first N calls return unfetchable, the next call returns
 * ok. Phase 3 walkback calls `classifyVersion(candidate)` for
 * candidate = includedV, includedV-1, ... — so the FIRST call is the
 * broken slot.
 *
 * @param brokenCount  How many of the latest walkback steps should be
 *                     reported as unfetchable. After that many, return
 *                     ok and let the walkback succeed.
 */
function makeFetcherWithBrokenLatestN(brokenCount: number): {
  fetcher: CarFetcher;
  callsObserved: () => number;
} {
  let calls = 0;
  return {
    fetcher: async () => {
      calls += 1;
      if (calls <= brokenCount) {
        return { ok: false, kind: 'transient_unavailable' };
      }
      return { ok: true };
    },
    callsObserved: () => calls,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('Phase 3 walkback — EXISTS-BUT-UNFETCHABLE skip-past (default policy)', () => {
  it('walkback skips a single TRANSIENT_UNAVAILABLE slot and returns the older fetchable predecessor', async () => {
    // vTrue = 5: aggregator has proofs at versions 1..5. Phase 1+2 find
    // includedV = 5. Phase 3 walkback starts at candidate=5; classifyVersion(5)
    // returns TRANSIENT_UNAVAILABLE (CAR unreachable). Under the new default
    // (`skipUnfetchableInWalkback: true`), the walkback records v=5 in
    // `walkbackUnfetchableSkipped` and continues to candidate=4. classifyVersion(4)
    // returns VALID (CAR ok). Returns { validV: 4, includedV: 5 }.
    const { keyMaterial, signer } = await buildIdentity();
    const vTrue = 5;
    const { client } = await makeVersionRoutingAggregator(vTrue, 64, keyMaterial, signer);

    // Phase 3 calls classifyVersion(5) first → CAR unfetchable. Then
    // classifyVersion(4) → CAR ok.
    const { fetcher } = makeFetcherWithBrokenLatestN(1);

    const result = await findLatestValidVersion({
      currentLocalVersion: 0 as PointerVersion,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecoder,
      fetchCar: fetcher,
      // skipUnfetchableInWalkback: true is the default — assert that
      // omitting it gives the new behavior.
    });

    expect(result.includedV).toBe(vTrue);
    expect(result.validV).toBe(4);
    expect(result.walkbackUnfetchableSkipped).toEqual([5]);
  });

  it('walkback skips MULTIPLE consecutive unfetchable slots before finding VALID', async () => {
    // vTrue = 10, broken latest 3 → expect validV=7, skipped=[10,9,8].
    const { keyMaterial, signer } = await buildIdentity();
    const vTrue = 10;
    const { client } = await makeVersionRoutingAggregator(vTrue, 64, keyMaterial, signer);

    const { fetcher } = makeFetcherWithBrokenLatestN(3);

    const result = await findLatestValidVersion({
      currentLocalVersion: 0 as PointerVersion,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecoder,
      fetchCar: fetcher,
    });

    expect(result.includedV).toBe(vTrue);
    expect(result.validV).toBe(7);
    expect(result.walkbackUnfetchableSkipped).toEqual([10, 9, 8]);
  });

  it('walkback returns validV=0 when ALL fetchable slots are unfetchable (no predecessor found)', async () => {
    // vTrue = 3, all 3 broken → walks back through 3, 2, 1, 0 → returns
    // validV=0, skipped=[3,2,1]. The wallet recovery treats validV=0 as
    // "no anchor published yet" — the wallet stays live (no throw) and
    // can begin publishing at v=1.
    const { keyMaterial, signer } = await buildIdentity();
    const vTrue = 3;
    const { client } = await makeVersionRoutingAggregator(vTrue, 64, keyMaterial, signer);

    const { fetcher } = makeFetcherWithBrokenLatestN(3);

    const result = await findLatestValidVersion({
      currentLocalVersion: 0 as PointerVersion,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecoder,
      fetchCar: fetcher,
    });

    expect(result.includedV).toBe(vTrue);
    expect(result.validV).toBe(0);
    expect(result.walkbackUnfetchableSkipped).toEqual([3, 2, 1]);
  });

  it('walkback with NO unfetchable slots returns empty walkbackUnfetchableSkipped', async () => {
    // No broken slots → first classifyVersion call returns VALID → no skip
    // records. Confirms the new field defaults to empty array (no
    // false-positive observability noise on the happy path).
    const { keyMaterial, signer } = await buildIdentity();
    const vTrue = 5;
    const { client } = await makeVersionRoutingAggregator(vTrue, 64, keyMaterial, signer);

    const { fetcher } = makeFetcherWithBrokenLatestN(0);

    const result = await findLatestValidVersion({
      currentLocalVersion: 0 as PointerVersion,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecoder,
      fetchCar: fetcher,
    });

    expect(result.validV).toBe(5);
    expect(result.walkbackUnfetchableSkipped).toEqual([]);
  });

  it('walkback unfetchable skips count toward the walkback budget (DISCOVERY_CORRUPT_WALKBACK)', async () => {
    // vTrue = 128, ALL slots unfetchable → walkback exhausts
    // DISCOVERY_CORRUPT_WALKBACK (=64) steps without finding VALID and
    // bails out with CORRUPT_STREAK. This pins the safety invariant: the
    // skip-past does NOT silently extend the walkback budget — the
    // wallet still gets the CORRUPT_STREAK signal so operators can
    // invoke acceptCorruptStreak / acceptCarLoss with a wider limit.
    //
    // The error details MUST also include `unfetchableSkippedCount` so
    // operators can distinguish "gateway down" from "wallet corrupt"
    // when both surface as CORRUPT_STREAK.
    const { keyMaterial, signer } = await buildIdentity();
    const vTrue = 128;
    const maxV = 1024;
    const { client } = await makeVersionRoutingAggregator(vTrue, maxV, keyMaterial, signer);

    // Every fetch returns transient_unavailable → every walkback step is a
    // skip-past, exhausting the default 64-step budget.
    const { fetcher } = makeFetcherWithBrokenLatestN(1_000_000);

    let caught: unknown = null;
    try {
      await findLatestValidVersion({
        currentLocalVersion: 0 as PointerVersion,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: fetcher,
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toMatchObject({
      code: AggregatorPointerErrorCode.CORRUPT_STREAK,
    });
    const details = (caught as { details?: Record<string, unknown> } | null)?.details;
    expect(details).toBeDefined();
    if (!details) return;
    // All walkback steps were skipped under the unfetchable policy —
    // operator can see this in the error details to triage IPFS health.
    expect(details['unfetchableSkippedCount']).toBeGreaterThan(0);
    expect(details['unfetchableSkippedCount']).toBe(details['walkedSoFar']);
  });
});

describe('Phase 3 walkback — SPEC-strict opt-in (`skipUnfetchableInWalkback: false`)', () => {
  it('SPEC-strict mode still throws CAR_UNAVAILABLE on TRANSIENT_UNAVAILABLE', async () => {
    // The legacy contract is preserved for callers that want the
    // operator-driven acceptCarLoss(version) flow. Passing
    // `skipUnfetchableInWalkback: false` restores the SPEC §13 throw.
    const { keyMaterial, signer } = await buildIdentity();
    const vTrue = 5;
    const { client } = await makeVersionRoutingAggregator(vTrue, 64, keyMaterial, signer);

    const { fetcher } = makeFetcherWithBrokenLatestN(1);

    await expect(
      findLatestValidVersion({
        currentLocalVersion: 0 as PointerVersion,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: fetcher,
        skipUnfetchableInWalkback: false,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.CAR_UNAVAILABLE,
    });
  });

  it('SPEC-strict mode CAR_UNAVAILABLE includes the broken version + includedV in error details', async () => {
    // The error MUST surface enough context for the operator to invoke
    // acceptCarLoss(version) — version is the broken slot, includedV is
    // the Phase 2 result. Regression check.
    const { keyMaterial, signer } = await buildIdentity();
    const vTrue = 7;
    const { client } = await makeVersionRoutingAggregator(vTrue, 64, keyMaterial, signer);

    const { fetcher } = makeFetcherWithBrokenLatestN(1);

    let caught: unknown = null;
    try {
      await findLatestValidVersion({
        currentLocalVersion: 0 as PointerVersion,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: fetcher,
        skipUnfetchableInWalkback: false,
      });
    } catch (e) {
      caught = e;
    }

    const details = (caught as { details?: Record<string, unknown> } | null)?.details;
    expect(details).toBeDefined();
    if (!details) return;
    expect(details['version']).toBe(7);
    expect(details['includedV']).toBe(vTrue);
  });
});

describe('Phase 3 walkback — semantics regression coverage', () => {
  it('PUBLISH semantics: `includedV` reflects the highest INCLUDED slot regardless of fetchability', async () => {
    // This is THE invariant that makes the skip-past safe for the
    // publish path: a new publish targets `max(validV, includedV) + 1`.
    // Even when validV is rewound by skip-past, includedV stays at the
    // true peak — so the new publish supersedes ABOVE the broken slot.
    const { keyMaterial, signer } = await buildIdentity();
    const vTrue = 10;
    const { client } = await makeVersionRoutingAggregator(vTrue, 64, keyMaterial, signer);

    const { fetcher } = makeFetcherWithBrokenLatestN(2);

    const result = await findLatestValidVersion({
      currentLocalVersion: 0 as PointerVersion,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecoder,
      fetchCar: fetcher,
    });

    // validV walked back past the broken slots:
    expect(result.validV).toBe(8);
    // includedV is unchanged — Phase 2 doesn't fetch CARs:
    expect(result.includedV).toBe(vTrue);
    // Publish would compute nextV = max(8, 10) + 1 = 11 → supersedes the
    // broken slot cleanly. Slot 11 is fresh; no collision with the broken 9/10.
    expect(Math.max(result.validV, result.includedV) + 1).toBe(11);
  });
});
