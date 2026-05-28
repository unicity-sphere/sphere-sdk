/**
 * Issue #310 — `findLatestValidVersion` integration with the epoch
 * floor.
 *
 * The probe-sequence machinery requires deep key-material wiring that
 * the parent test file documents as "impractical without full probe-
 * sequence simulation." For #310 we focus on the OBSERVABLE
 * surface — the `DiscoverResult` shape and the input acceptance — and
 * pin the epoch-floor walkback semantics via the pure unit suite in
 * `epoch-floor.test.ts`.
 *
 * Additional coverage (the integration test) lives at:
 *   `tests/integration/pointer/walkback-epoch-floor.test.ts`
 * (only if real-probe simulation gets wired in a follow-up).
 */

import { describe, it, expect, vi } from 'vitest';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import { InclusionProofResponse } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProofResponse.js';
import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

import {
  findLatestValidVersion,
  AggregatorPointerErrorCode,
  derivePointerKeyMaterial,
  buildPointerSigner,
  createMasterPrivateKey,
  type CidDecoder,
  type CarFetcher,
  type PointerVersion,
} from '../../../../profile/aggregator-pointer/index.js';

const WALLET_SEED = new Uint8Array(32).fill(0x42);
const VALID_CID = new Uint8Array([0x12, 0x20, ...new Array(32).fill(0xab)]);

async function buildFixtures() {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

function fakeProof(status: InclusionProofVerificationStatus): InclusionProof {
  return {
    verify: vi.fn(async () => status),
    transactionHash: { data: new Uint8Array(32).fill(0x01), imprint: new Uint8Array(34) },
    unicityCertificate: {
      unicitySeal: { epoch: 1n },
      inputRecord: { epoch: 1n },
    },
  } as unknown as InclusionProof;
}

function fakeTrustBase(): RootTrustBase {
  return { epoch: 1n } as RootTrustBase;
}

function allNotIncludedClient(): AggregatorClient {
  return {
    getInclusionProof: vi.fn(async () =>
      new InclusionProofResponse(
        fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED),
      ),
    ),
  } as unknown as AggregatorClient;
}

const okDecoder: CidDecoder = () => ({ ok: true, cidBytes: VALID_CID });
const validFetcher: CarFetcher = async () => ({ ok: true });

describe('findLatestValidVersion — #310 result shape', () => {
  it('returns walkbackEpochSkipped + pickedEpoch=0 for an empty wallet', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const result = await findLatestValidVersion({
      currentLocalVersion: 0,
      keyMaterial,
      signer,
      aggregatorClient: allNotIncludedClient(),
      trustBase: fakeTrustBase(),
      decodeCid: okDecoder,
      fetchCar: validFetcher,
    });
    expect(result.validV).toBe(0);
    expect(result.walkbackEpochSkipped).toEqual([]);
    expect(result.pickedEpoch).toBe(0);
  });

  it('honors initialEpochFloor (primes the running floor)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const result = await findLatestValidVersion({
      currentLocalVersion: 0,
      keyMaterial,
      signer,
      aggregatorClient: allNotIncludedClient(),
      trustBase: fakeTrustBase(),
      decodeCid: okDecoder,
      fetchCar: validFetcher,
      initialEpochFloor: 7,
    });
    // No Phase-3 walkback ran (wallet is empty), so pickedEpoch is
    // the primed floor.
    expect(result.pickedEpoch).toBe(7);
  });

  it('rejects negative initialEpochFloor with PROTOCOL_ERROR', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    await expect(
      findLatestValidVersion({
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: allNotIncludedClient(),
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: validFetcher,
        initialEpochFloor: -1,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
    });
  });

  it('rejects non-integer initialEpochFloor with PROTOCOL_ERROR', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    await expect(
      findLatestValidVersion({
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: allNotIncludedClient(),
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: validFetcher,
        initialEpochFloor: 1.5,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
    });
  });

  it('accepts inspectSnapshotEpoch as a callback type (no-op for empty wallet)', async () => {
    // Empty-wallet path does not actually CALL the inspector (no
    // VALID candidate gets classified), but the field should be
    // accepted without complaint.
    const { keyMaterial, signer } = await buildFixtures();
    let inspectCalls = 0;
    const inspector = async (_v: PointerVersion, _cid: Uint8Array): Promise<number | undefined> => {
      inspectCalls += 1;
      return 0;
    };
    const result = await findLatestValidVersion({
      currentLocalVersion: 0,
      keyMaterial,
      signer,
      aggregatorClient: allNotIncludedClient(),
      trustBase: fakeTrustBase(),
      decodeCid: okDecoder,
      fetchCar: validFetcher,
      inspectSnapshotEpoch: inspector,
    });
    expect(result.validV).toBe(0);
    expect(inspectCalls).toBe(0); // never reached for empty wallet
  });
});
