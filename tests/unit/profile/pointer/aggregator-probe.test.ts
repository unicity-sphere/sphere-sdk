/**
 * Aggregator probe + classifyVersion (T-C2, T-C8) — SPEC §8.1, §8.2.
 *
 * Covers:
 *   - probeVersion H2 OR-predicate (either side → true)
 *   - probeVersion raises TRUST_BASE_STALE on rotation (cert.epoch > local)
 *   - probeVersion raises UNTRUSTED_PROOF on forgery (cert.epoch <= local)
 *   - classifyVersion three-way (VALID / SEMANTICALLY_INVALID / TRANSIENT_UNAVAILABLE)
 *   - isReachable returns true on any HTTP response, false on network failure
 */

import { describe, it, expect, vi } from 'vitest';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import { InclusionProofResponse } from '@unicitylabs/state-transition-sdk/lib/api/InclusionProofResponse.js';
import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

import {
  probeVersion,
  classifyVersion,
  isReachable,
  classifyTrustBaseRotation,
  raiseForTrustBaseMismatch,
  AggregatorPointerErrorCode,
  derivePointerKeyMaterial,
  buildPointerSigner,
  createMasterPrivateKey,
  type CidDecoder,
  type CarFetcher,
} from '../../../../profile/aggregator-pointer/index.js';

// ── Fixtures ───────────────────────────────────────────────────────────────

const WALLET_SEED = new Uint8Array(32).fill(0x42);

async function buildFixtures() {
  const masterKey = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(masterKey);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

/** Build a fake InclusionProof-like object. We stub `.verify()` directly. */
function fakeProof(
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

function fakeClient(proofsForRequests: InclusionProof[]): AggregatorClient {
  let idx = 0;
  return {
    getInclusionProof: vi.fn(async () => {
      const proof = proofsForRequests[idx % proofsForRequests.length]!;
      idx += 1;
      return new InclusionProofResponse(proof);
    }),
  } as unknown as AggregatorClient;
}

function fakeTrustBase(epoch: bigint = 1n): RootTrustBase {
  return { epoch } as RootTrustBase;
}

// ── probeVersion (H2 OR-predicate) ─────────────────────────────────────────

describe('probeVersion — H2 OR-predicate (SPEC §8.1)', () => {
  it('returns true when both sides verify OK', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const included = await probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase });
    expect(included).toBe(true);
  });

  it('returns true when only side A verifies OK (partial-residue)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const included = await probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase });
    expect(included).toBe(true);
  });

  it('returns true when only side B verifies OK', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const included = await probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase });
    expect(included).toBe(true);
  });

  it('returns false when both sides PATH_NOT_INCLUDED (legitimate non-inclusion)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const included = await probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase });
    expect(included).toBe(false);
  });

  it('raises TRUST_BASE_STALE when proof epoch > local epoch (rotation)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 5n);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK, 5n);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase(3n); // bundled epoch is older

    await expect(
      probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.TRUST_BASE_STALE });
  });

  it('raises UNTRUSTED_PROOF when NOT_AUTHENTICATED at same epoch (forgery)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 3n);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK, 3n);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase(3n);

    await expect(
      probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.UNTRUSTED_PROOF });
  });

  it('raises UNTRUSTED_PROOF on PATH_INVALID (structurally bad proof)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_INVALID, 1n);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase(1n);

    await expect(
      probeVersion({ v: 5, keyMaterial, signer, aggregatorClient: client, trustBase }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.UNTRUSTED_PROOF });
  });

  // Wave G.2/G.4 regression — abortSignal propagation
  it('rejects with AbortError when abortSignal is already aborted (steelman wave G)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      probeVersion({
        v: 1,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase,
        abortSignal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'PointerProbeAborted' });
  });

  it('rejects when abortSignal fires during in-flight probe (steelman wave G)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    // Build a never-resolving InclusionProof fetch so we can test cancellation.
    const slowClient = {
      getInclusionProof: vi.fn(() => new Promise<never>(() => {
        // never resolves
      })),
    } as unknown as AggregatorClient;
    const trustBase = fakeTrustBase();
    const ctrl = new AbortController();
    const probePromise = probeVersion({
      v: 1,
      keyMaterial,
      signer,
      aggregatorClient: slowClient,
      trustBase,
      timeoutMs: 60_000, // long enough that the abort wins
      abortSignal: ctrl.signal,
    });
    // Fire the abort after a microtask so the promise is in flight.
    queueMicrotask(() => ctrl.abort());
    await expect(probePromise).rejects.toMatchObject({ name: 'PointerProbeAborted' });
  });
});

// ── classifyVersion (H1 three-way) ─────────────────────────────────────────

describe('classifyVersion — H1 three-way (SPEC §8.2)', () => {
  const validCid = new Uint8Array([0x12, 0x20, ...new Array(32).fill(0xab)]);

  const okDecoder: CidDecoder = () => ({ ok: true, cidBytes: validCid });
  const failDecoder: CidDecoder = () => ({ ok: false });

  const validFetcher: CarFetcher = async () => ({ ok: true });
  const transientFetcher: CarFetcher = async () => ({ ok: false, kind: 'transient_unavailable' });
  const contentMismatchFetcher: CarFetcher = async () => ({ ok: false, kind: 'content_mismatch' });
  const carParseFetcher: CarFetcher = async () => ({ ok: false, kind: 'car_parse_failed' });

  it('returns VALID when both sides OK + CID parses + CAR fetches successfully', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: validFetcher,
    });
    expect(result).toBe('VALID');
  });

  it('returns SEMANTICALLY_INVALID when either side PATH_NOT_INCLUDED', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: validFetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });

  it('returns SEMANTICALLY_INVALID when CID decode fails', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: failDecoder,
      fetchCar: validFetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });

  it('returns SEMANTICALLY_INVALID when transactionHash is null', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK, 1n, null);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: validFetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });

  it('returns TRANSIENT_UNAVAILABLE when CAR fetch reports transient', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: transientFetcher,
    });
    expect(result).toBe('TRANSIENT_UNAVAILABLE');
  });

  it('returns SEMANTICALLY_INVALID on CAR content-address mismatch', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: contentMismatchFetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });

  it('returns SEMANTICALLY_INVALID on CAR parse failure', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.OK);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: carParseFetcher,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });

  it('returns TRANSIENT_UNAVAILABLE when proof fetch fails with network error', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw new Error('fetch timeout');
      }),
    } as unknown as AggregatorClient;
    const trustBase = fakeTrustBase();

    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase,
      decodeCid: okDecoder,
      fetchCar: validFetcher,
    });
    expect(result).toBe('TRANSIENT_UNAVAILABLE');
  });

  it('raises TRUST_BASE_STALE when proof epoch > local epoch', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const proofA = fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 10n);
    const proofB = fakeProof(InclusionProofVerificationStatus.OK, 10n);
    const client = fakeClient([proofA, proofB]);
    const trustBase = fakeTrustBase(5n);

    await expect(
      classifyVersion({
        v: 5,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase,
        decodeCid: okDecoder,
        fetchCar: validFetcher,
      }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.TRUST_BASE_STALE });
  });

  it('raises PROTOCOL_ERROR when SDK response is missing inclusionProof (shape drift)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    // Simulate SDK shape drift: getInclusionProof returns a response
    // object without the inclusionProof field. Previously this threw
    // a TypeError that was caught as transient and retried forever;
    // now it raises AggregatorPointerError(PROTOCOL_ERROR) that the
    // caller can surface cleanly.
    const malformedClient = {
      getInclusionProof: vi.fn(async () => ({ /* no inclusionProof */ })),
    } as unknown as AggregatorClient;
    const trustBase = fakeTrustBase();

    await expect(
      classifyVersion({
        v: 5,
        keyMaterial,
        signer,
        aggregatorClient: malformedClient,
        trustBase,
        decodeCid: okDecoder,
        fetchCar: validFetcher,
      }),
    ).rejects.toMatchObject({ code: AggregatorPointerErrorCode.PROTOCOL_ERROR });
  });
});

// ── isReachable (health check) ─────────────────────────────────────────────

describe('isReachable', () => {
  const signingPubKey = new Uint8Array(33).fill(0x02);

  it('returns true on any HTTP response (aggregator reachable)', async () => {
    const client = {
      getInclusionProof: vi.fn(async () => new InclusionProofResponse(fakeProof(InclusionProofVerificationStatus.PATH_NOT_INCLUDED))),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(true);
  });

  it('returns true on 5xx response (still reachable, just unhappy)', async () => {
    const err = new Error('Internal Server Error') as Error & { name: string; status: number };
    err.name = 'JsonRpcNetworkError';
    err.status = 500;

    const client = {
      getInclusionProof: vi.fn(async () => { throw err; }),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(true);
  });

  it('returns true on JSON-RPC error (reachable)', async () => {
    const err = new Error('ConcurrencyLimit') as Error & { name: string; code: number };
    err.name = 'JsonRpcError';
    err.code = -32006;

    const client = {
      getInclusionProof: vi.fn(async () => { throw err; }),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(true);
  });

  it('returns false on network-level failure (timeout/ECONNREFUSED)', async () => {
    const client = {
      getInclusionProof: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }),
    } as unknown as AggregatorClient;

    const reachable = await isReachable({ signingPubKey, aggregatorClient: client });
    expect(reachable).toBe(false);
  });
});

// ── classifyTrustBaseRotation + raiseForTrustBaseMismatch ──────────────────

describe('classifyTrustBaseRotation (T-C4)', () => {
  it('isRotation=true when certEpoch > localEpoch', () => {
    const trustBase = fakeTrustBase(3n);
    const proof = fakeProof(InclusionProofVerificationStatus.OK, 5n);
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result).toEqual({ isRotation: true, localEpoch: 3n, certEpoch: 5n });
  });

  it('isRotation=false when certEpoch == localEpoch', () => {
    const trustBase = fakeTrustBase(3n);
    const proof = fakeProof(InclusionProofVerificationStatus.OK, 3n);
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(false);
  });

  it('isRotation=false when certEpoch < localEpoch (replay)', () => {
    const trustBase = fakeTrustBase(5n);
    const proof = fakeProof(InclusionProofVerificationStatus.OK, 2n);
    const result = classifyTrustBaseRotation(trustBase, proof);
    expect(result.isRotation).toBe(false);
  });
});

describe('raiseForTrustBaseMismatch (T-C4)', () => {
  it('throws TRUST_BASE_STALE on rotation', () => {
    const trustBase = fakeTrustBase(1n);
    const proof = fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 5n);
    expect(() => raiseForTrustBaseMismatch(trustBase, proof, 'test')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.TRUST_BASE_STALE }),
    );
  });

  it('throws UNTRUSTED_PROOF on non-rotation mismatch', () => {
    const trustBase = fakeTrustBase(3n);
    const proof = fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 3n);
    expect(() => raiseForTrustBaseMismatch(trustBase, proof, 'test')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.UNTRUSTED_PROOF }),
    );
  });

  it('throws UNTRUSTED_PROOF on replay (lower epoch)', () => {
    const trustBase = fakeTrustBase(5n);
    const proof = fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 2n);
    expect(() => raiseForTrustBaseMismatch(trustBase, proof, 'test')).toThrow(
      expect.objectContaining({ code: AggregatorPointerErrorCode.UNTRUSTED_PROOF }),
    );
  });
});
