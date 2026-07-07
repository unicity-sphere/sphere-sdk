/**
 * Wave 6-P2-10b — Discover algorithm (T-D2) coverage restoration.
 *
 * The legacy tests in tests/legacy-v1/unit/profile/pointer/discover-algorithm.test.ts
 * were quarantined in wave 6-P2-5. This file restores the highest-value
 * algorithm invariants at the v2 pointer layer surface:
 *
 *   Phase 1 — exponential expansion:
 *     - All PATH_NOT_INCLUDED → validV=0 (pristine wallet)
 *     - All OK → hits DISCOVERY_HARD_CEILING → DISCOVERY_OVERFLOW
 *
 *   currentLocalVersion validation:
 *     - Negative / non-integer / at-or-above HARD_CEILING → PROTOCOL_ERROR
 *
 *   Deadline diagnostics (issue #450):
 *     - Caller-supplied deadline already in the past → RETRY_EXHAUSTED
 *       with "deadline already past at start" message
 *
 *   abortSignal propagation:
 *     - Pre-aborted signal → RETRY_EXHAUSTED immediately
 *
 *   Walkback floor (W7):
 *     - walkbackLimit outside [0, 4096] → PROTOCOL_ERROR
 *
 *   initialEpochFloor validation:
 *     - Negative / non-integer → PROTOCOL_ERROR
 *
 *   computeProbeFingerprint:
 *     - Empty list → ""
 *     - Order-independent (sorts internally)
 *     - Deterministic for same input; differs for different input
 *     - Out-of-range version → VERSION_OUT_OF_RANGE
 *
 * The tests avoid exercising the per-version-routed mock (which would
 * require reverse-engineering probe request IDs); coverage of Phase 2/3
 * branch behavior is preserved by the classify/probe unit tests in
 * `aggregator-probe.v2.test.ts` and by the pre-existing epoch-floor and
 * walkback-floor-retry tests in tests/unit/profile/pointer/.
 */

import { describe, it, expect, vi } from 'vitest';
import { InclusionProofVerificationStatus } from 'stsdk-v1/lib/transaction/InclusionProof.js';
import type { InclusionProof } from 'stsdk-v1/lib/transaction/InclusionProof.js';
import type { AggregatorClient } from 'stsdk-v1/lib/api/AggregatorClient.js';
import type { RootTrustBase } from 'stsdk-v1/lib/bft/RootTrustBase.js';

import {
  findLatestValidVersion,
  computeProbeFingerprint,
  AggregatorPointerErrorCode,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  buildPointerSigner,
  DISCOVERY_HARD_CEILING,
  VERSION_MAX,
  type CarFetcher,
  type CidDecoder,
} from '../../../extensions/uxf/profile/aggregator-pointer/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const WALLET_SEED = new Uint8Array(32).fill(0x42);
const VALID_CID = new Uint8Array(36).fill(0xab);

async function buildFixtures() {
  const master = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(master);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

function fakeProof(status: InclusionProofVerificationStatus): InclusionProof {
  return {
    verify: vi.fn(async () => status),
    transactionHash: {
      data: new Uint8Array(32).fill(0x01),
      imprint: new Uint8Array(34),
    },
    unicityCertificate: {
      unicitySeal: { epoch: 1n },
      inputRecord: { epoch: 1n },
    },
  } as unknown as InclusionProof;
}

function fakeTrustBase(): RootTrustBase {
  return { epoch: 1n } as unknown as RootTrustBase;
}

function allNotIncludedClient(): AggregatorClient {
  return {
    getInclusionProof: vi.fn(async () => ({
      inclusionProof: fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED),
    })),
  } as unknown as AggregatorClient;
}

function allOKClient(): AggregatorClient {
  return {
    getInclusionProof: vi.fn(async () => ({
      inclusionProof: fakeProof(InclusionProofVerificationStatus.OK),
    })),
  } as unknown as AggregatorClient;
}

const okDecoder: CidDecoder = () => ({ ok: true, cidBytes: VALID_CID });
const validFetcher: CarFetcher = async () => ({ ok: true });

// ── Phase 1 — happy paths ─────────────────────────────────────────────────

describe('findLatestValidVersion — Phase 1 exponential expansion', () => {
  it('returns validV=0 when no pointer has ever been published', async () => {
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
    expect(result.includedV).toBe(0);
    // Phase 1 always probes at least one version.
    expect(result.probeVersions.length).toBeGreaterThan(0);
    expect(result.walkbackUnfetchableSkipped).toEqual([]);
    expect(result.walkbackEpochSkipped).toEqual([]);
  });

  it('raises DISCOVERY_OVERFLOW when probes keep returning true up to the hard ceiling', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    await expect(
      findLatestValidVersion({
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: allOKClient(),
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: validFetcher,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.DISCOVERY_OVERFLOW,
    });
  }, 30_000);
});

// ── Input validation (fail-fast) ──────────────────────────────────────────

describe('findLatestValidVersion — input validation', () => {
  it('raises PROTOCOL_ERROR on negative currentLocalVersion', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    await expect(
      findLatestValidVersion({
        currentLocalVersion: -1,
        keyMaterial,
        signer,
        aggregatorClient: allNotIncludedClient(),
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: validFetcher,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
    });
  });

  it('raises PROTOCOL_ERROR when currentLocalVersion >= DISCOVERY_HARD_CEILING', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    await expect(
      findLatestValidVersion({
        currentLocalVersion: DISCOVERY_HARD_CEILING,
        keyMaterial,
        signer,
        aggregatorClient: allNotIncludedClient(),
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: validFetcher,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
    });
  });

  it('raises PROTOCOL_ERROR when walkbackLimit is out of range (non-integer)', async () => {
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
        walkbackLimit: 3.14,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
    });
  });

  it('raises PROTOCOL_ERROR when walkbackLimit is negative', async () => {
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
        walkbackLimit: -1,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
    });
  });

  it('raises PROTOCOL_ERROR when walkbackLimit exceeds the 4096 hard cap', async () => {
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
        walkbackLimit: 4097,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
    });
  });

  it('raises PROTOCOL_ERROR when initialEpochFloor is negative', async () => {
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

  it('raises PROTOCOL_ERROR when initialEpochFloor is non-integer', async () => {
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
        initialEpochFloor: 2.5,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
    });
  });
});

// ── Deadline diagnostic (#450) ────────────────────────────────────────────

describe('findLatestValidVersion — deadline propagation', () => {
  it('raises RETRY_EXHAUSTED with "deadline already past at start" when caller supplied deadline is in the past', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const pastDeadline = Date.now() - 12_345;
    let caught: unknown;
    try {
      await findLatestValidVersion({
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: allNotIncludedClient(),
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: validFetcher,
        discoveryDeadlineMs: pastDeadline,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe(
      AggregatorPointerErrorCode.RETRY_EXHAUSTED,
    );
    const msg = (caught as { message: string }).message;
    expect(msg).toMatch(/already .*ms in the past at start/);
    expect(msg).toMatch(/caller-supplied deadline had already expired/);
  });

  it('raises RETRY_EXHAUSTED when abortSignal is fired before discovery starts', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      findLatestValidVersion({
        currentLocalVersion: 0,
        keyMaterial,
        signer,
        aggregatorClient: allNotIncludedClient(),
        trustBase: fakeTrustBase(),
        decodeCid: okDecoder,
        fetchCar: validFetcher,
        abortSignal: ctrl.signal,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.RETRY_EXHAUSTED,
    });
  });
});

// ── computeProbeFingerprint ───────────────────────────────────────────────

describe('computeProbeFingerprint (UI clustering signal)', () => {
  it('returns empty string for empty probe list', async () => {
    expect(await computeProbeFingerprint([])).toBe('');
  });

  it('is deterministic — identical input → identical fingerprint', async () => {
    const seq = [3, 7, 12, 25, 40];
    const fp1 = await computeProbeFingerprint(seq);
    const fp2 = await computeProbeFingerprint(seq);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[0-9a-f]{16}$/); // 8 bytes hex
  });

  it('sorts internally — order-independent', async () => {
    const fp1 = await computeProbeFingerprint([1, 4, 16, 64]);
    const fp2 = await computeProbeFingerprint([64, 16, 4, 1]);
    expect(fp1).toBe(fp2);
  });

  it('differs for different probe sequences', async () => {
    const fp1 = await computeProbeFingerprint([1, 2, 4]);
    const fp2 = await computeProbeFingerprint([1, 2, 5]);
    expect(fp1).not.toBe(fp2);
  });

  it('raises VERSION_OUT_OF_RANGE on a version > VERSION_MAX', async () => {
    await expect(computeProbeFingerprint([VERSION_MAX + 1])).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.VERSION_OUT_OF_RANGE,
    });
  });

  it('raises VERSION_OUT_OF_RANGE on a negative version', async () => {
    await expect(computeProbeFingerprint([-1])).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.VERSION_OUT_OF_RANGE,
    });
  });
});
