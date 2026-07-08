/**
 * Wave 6-P2-16 — Aggregator probe (T-C2) v2 API coverage.
 *
 * The v2 state-transition SDK replaced v1's
 * `getInclusionProof(RequestId)` / `proof.verify(trustBase, requestId)`
 * with `getInclusionProof(StateId)` returning `InclusionProofResponse` and
 * verification via `InclusionProofVerificationRule.verify(trustBase,
 * predicateVerifier, proof, transaction)`. The pointer probe wraps that
 * call in `verifyPointerInclusionProof` (see aggregator-probe.ts).
 *
 * This test file mocks `InclusionProofVerificationRule` at the module
 * level so the probe classification (H2 OR-predicate; four-way
 * classifier; rotation-vs-forgery decision) can be driven from a fake
 * verifier without instantiating the real merkle-path / crypto layers.
 *
 *   Probe path (probeVersion, SPEC §8.1 H2 OR-predicate):
 *     - Both sides OK → included=true
 *     - Only one side OK → included=true (H2 OR-predicate)
 *     - Both INCLUSION_CERTIFICATE_MISSING → included=false
 *     - Rotation / forgery: NOT_AUTHENTICATED / PATH_INVALID short-circuit
 *       through raiseForTrustBaseMismatch (TRUST_BASE_STALE vs UNTRUSTED_PROOF)
 *     - PROTOCOL_ERROR when the SDK response shape is wrong
 *     - AbortSignal cancels an in-flight probe RPC
 *
 *   Classify path (classifyVersion, SPEC §8.2 four-way):
 *     - Both sides OK + CID decoded + CAR fetched → VALID
 *     - Partial inclusion (one side missing) → SEMANTICALLY_INVALID
 *     - CID decoder fails on the reconstructed 64-byte plaintext → SEMANTICALLY_INVALID
 *     - Proof RPC failure (network) → PROOF_TRANSIENT (must NOT collapse to CAR_TRANSIENT)
 *     - Proof + CID ok but CAR unfetchable (transient) → CAR_TRANSIENT
 *     - CAR content_mismatch / car_parse_failed → SEMANTICALLY_INVALID
 *
 *   decodeVersionCid (standalone Phase 1+2):
 *     - Returns cidBytes on success
 *     - Reports 'transient' / 'semantic' failure reasons
 *
 *   Reachability (isReachable, SPEC §11.12):
 *     - Any HTTP response → reachable
 *     - Genuine transport failure (timeout / DNS) → not reachable
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  AggregatorClient,
  InclusionProof,
  InclusionProofVerificationStatus,
  RootTrustBase,
} from '../../../token-engine/sdk.js';

// Mock InclusionProofVerificationRule so the probe can be driven without
// touching real crypto. We attach the `verify` return value onto the fake
// proof object as `__verifyResult` and read it back in the mock.
vi.mock('../../../token-engine/sdk.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    InclusionProofVerificationRule: {
      verify: vi.fn(async (_trustBase, _predVerifier, proof: InclusionProof) => {
        const withResult = proof as InclusionProof & { __verifyResult?: string };
        return { status: withResult.__verifyResult ?? 'INCLUSION_CERTIFICATE_MISSING' };
      }),
    },
  };
});

import {
  probeVersion,
  classifyVersion,
  decodeVersionCid,
  isReachable,
  createMasterPrivateKey,
  derivePointerKeyMaterial,
  buildPointerSigner,
  AggregatorPointerErrorCode,
  type CarFetcher,
  type CidDecoder,
} from '../../../extensions/uxf/profile/aggregator-pointer/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const WALLET_SEED = new Uint8Array(32).fill(0x42);

async function buildFixtures() {
  const master = createMasterPrivateKey(WALLET_SEED);
  const keyMaterial = derivePointerKeyMaterial(master);
  const signer = await buildPointerSigner(keyMaterial.signingSeed);
  return { keyMaterial, signer };
}

/**
 * Build a fake `InclusionProof` for the v2 shape. The `__verifyResult`
 * marker is picked up by the mocked `InclusionProofVerificationRule.verify`
 * so tests can drive verification outcomes without real crypto.
 */
function fakeProof(
  verifyResult: InclusionProofVerificationStatus,
  certEpoch: bigint = 1n,
  txHashData: Uint8Array | null = new Uint8Array(32).fill(0x01),
): InclusionProof {
  return {
    __verifyResult: verifyResult,
    certificationData:
      txHashData === null
        ? null
        : {
            transactionHash: {
              data: txHashData,
              imprint: new Uint8Array([0x00, 0x00, ...txHashData]),
            },
          },
    inclusionCertificate: verifyResult === InclusionProofVerificationStatus.OK ? {} : null,
    unicityCertificate: {
      unicitySeal: { epoch: certEpoch },
      inputRecord: { epoch: certEpoch },
    },
  } as unknown as InclusionProof;
}

/**
 * A client that returns a fixed sequence of proofs (round-robin) via
 * `getInclusionProof`. The pointer probe path expects a response object
 * wrapping `.inclusionProof`.
 */
function fakeClient(proofs: readonly InclusionProof[]): AggregatorClient {
  let idx = 0;
  return {
    getInclusionProof: vi.fn(async () => {
      const proof = proofs[idx % proofs.length]!;
      idx += 1;
      return { inclusionProof: proof, blockNumber: 1n };
    }),
  } as unknown as AggregatorClient;
}

function fakeTrustBase(epoch: bigint = 1n): RootTrustBase {
  return { epoch } as unknown as RootTrustBase;
}

const okDecodeCid: CidDecoder = (full) => ({ ok: true, cidBytes: full.slice(0, 36) });
const badDecodeCid: CidDecoder = () => ({ ok: false });
const okFetchCar: CarFetcher = async () => ({ ok: true });
const transientFetchCar: CarFetcher = async () => ({ ok: false, kind: 'transient_unavailable' });
const contentMismatchFetchCar: CarFetcher = async () => ({ ok: false, kind: 'content_mismatch' });

beforeEach(() => {
  vi.clearAllMocks();
});

// ── probeVersion — H2 OR-predicate ────────────────────────────────────────

describe('probeVersion (SPEC §8.1 H2 OR-predicate)', () => {
  it('returns true when both sides verify OK', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.OK),
    ]);
    const included = await probeVersion({
      v: 4,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
    });
    expect(included).toBe(true);
  });

  it('returns true when only side A verifies OK (H2 OR-predicate)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.INCLUSION_CERTIFICATE_MISSING),
    ]);
    const included = await probeVersion({
      v: 7,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
    });
    expect(included).toBe(true);
  });

  it('returns false when both sides INCLUSION_CERTIFICATE_MISSING', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.INCLUSION_CERTIFICATE_MISSING),
      fakeProof(InclusionProofVerificationStatus.INCLUSION_CERTIFICATE_MISSING),
    ]);
    const included = await probeVersion({
      v: 9,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
    });
    expect(included).toBe(false);
  });

  it('raises TRUST_BASE_STALE when cert.epoch > local (legitimate rotation)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 5n),
      fakeProof(InclusionProofVerificationStatus.OK, 5n),
    ]);
    await expect(
      probeVersion({
        v: 3,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase: fakeTrustBase(3n),
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.TRUST_BASE_STALE,
    });
  });

  it('raises UNTRUSTED_PROOF when NOT_AUTHENTICATED at the same epoch (forgery)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.NOT_AUTHENTICATED, 3n),
      fakeProof(InclusionProofVerificationStatus.OK, 3n),
    ]);
    await expect(
      probeVersion({
        v: 3,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase: fakeTrustBase(3n),
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.UNTRUSTED_PROOF,
    });
  });

  it('raises UNTRUSTED_PROOF on PATH_INVALID (structurally bad proof)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.PATH_INVALID, 1n),
    ]);
    await expect(
      probeVersion({
        v: 2,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase: fakeTrustBase(1n),
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.UNTRUSTED_PROOF,
    });
  });

  it('rejects with PointerProbeAborted when abortSignal is already fired', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.OK),
    ]);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      probeVersion({
        v: 1,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase: fakeTrustBase(),
        abortSignal: ctrl.signal,
      }),
    ).rejects.toMatchObject({ name: 'PointerProbeAborted' });
  });
});

// ── classifyVersion — four-way SPEC §8.2 ──────────────────────────────────

describe('classifyVersion (SPEC §8.2 four-way)', () => {
  it('returns VALID when both proofs OK + CID decoded + CAR fetched', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.OK),
    ]);
    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecodeCid,
      fetchCar: okFetchCar,
    });
    expect(result).toBe('VALID');
  });

  it('returns SEMANTICALLY_INVALID on partial inclusion (one side missing)', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.INCLUSION_CERTIFICATE_MISSING),
    ]);
    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecodeCid,
      fetchCar: okFetchCar,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });

  it('returns SEMANTICALLY_INVALID when the CID decoder rejects the plaintext', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.OK),
    ]);
    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: badDecodeCid,
      fetchCar: okFetchCar,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });

  it('returns PROOF_TRANSIENT when the aggregator proof RPC throws a network error', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw Object.assign(new Error('ECONNREFUSED'), { name: 'FetchError' });
      }),
    } as unknown as AggregatorClient;
    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecodeCid,
      fetchCar: okFetchCar,
    });
    expect(result).toBe('PROOF_TRANSIENT');
  });

  it('returns CAR_TRANSIENT when proofs verify + CID decodes but CAR is unreachable', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.OK),
    ]);
    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecodeCid,
      fetchCar: transientFetchCar,
    });
    expect(result).toBe('CAR_TRANSIENT');
  });

  it('returns SEMANTICALLY_INVALID on CAR content_mismatch', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.OK),
    ]);
    const result = await classifyVersion({
      v: 5,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecodeCid,
      fetchCar: contentMismatchFetchCar,
    });
    expect(result).toBe('SEMANTICALLY_INVALID');
  });

  it('raises PROTOCOL_ERROR when the SDK response is missing inclusionProof', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = {
      getInclusionProof: vi.fn(async () => ({ inclusionProof: null })),
    } as unknown as AggregatorClient;
    await expect(
      classifyVersion({
        v: 5,
        keyMaterial,
        signer,
        aggregatorClient: client,
        trustBase: fakeTrustBase(),
        decodeCid: okDecodeCid,
        fetchCar: okFetchCar,
      }),
    ).rejects.toMatchObject({
      code: AggregatorPointerErrorCode.PROTOCOL_ERROR,
    });
  });
});

// ── decodeVersionCid — standalone Phase 1+2 ───────────────────────────────

describe('decodeVersionCid (Phase 1+2 standalone)', () => {
  it('returns { ok:true, cidBytes } when both sides verify + CID decodes', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.OK),
    ]);
    const result = await decodeVersionCid({
      v: 3,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecodeCid,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.cidBytes.length).toBe(36);
    }
  });

  it('reports { ok:false, reason:"transient" } when proof RPC fails', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw Object.assign(new Error('EAI_AGAIN'), { name: 'FetchError' });
      }),
    } as unknown as AggregatorClient;
    const result = await decodeVersionCid({
      v: 3,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: okDecodeCid,
    });
    expect(result).toEqual({ ok: false, reason: 'transient' });
  });

  it('reports { ok:false, reason:"semantic" } when CID decoder rejects', async () => {
    const { keyMaterial, signer } = await buildFixtures();
    const client = fakeClient([
      fakeProof(InclusionProofVerificationStatus.OK),
      fakeProof(InclusionProofVerificationStatus.OK),
    ]);
    const result = await decodeVersionCid({
      v: 3,
      keyMaterial,
      signer,
      aggregatorClient: client,
      trustBase: fakeTrustBase(),
      decodeCid: badDecodeCid,
    });
    expect(result).toEqual({ ok: false, reason: 'semantic' });
  });
});

// ── isReachable — health check (SPEC §11.12) ──────────────────────────────

describe('isReachable (SPEC §11.12)', () => {
  it('returns true on a well-formed response (aggregator answered)', async () => {
    const { signer } = await buildFixtures();
    const client = fakeClient([fakeProof(InclusionProofVerificationStatus.INCLUSION_CERTIFICATE_MISSING)]);
    const reachable = await isReachable({
      signingPubKey: signer.signingPubKey,
      aggregatorClient: client,
    });
    expect(reachable).toBe(true);
  });

  it('returns true on JsonRpcNetworkError (aggregator returned an HTTP error but is reachable)', async () => {
    const { signer } = await buildFixtures();
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw Object.assign(new Error('Service Unavailable'), {
          name: 'JsonRpcNetworkError',
          status: 503,
        });
      }),
    } as unknown as AggregatorClient;
    const reachable = await isReachable({
      signingPubKey: signer.signingPubKey,
      aggregatorClient: client,
    });
    expect(reachable).toBe(true);
  });

  it('returns true on JsonRpcError (JSON-RPC layer error still means aggregator replied)', async () => {
    const { signer } = await buildFixtures();
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw Object.assign(new Error('some error'), { name: 'JsonRpcError' });
      }),
    } as unknown as AggregatorClient;
    const reachable = await isReachable({
      signingPubKey: signer.signingPubKey,
      aggregatorClient: client,
    });
    expect(reachable).toBe(true);
  });

  it('returns false on a genuine transport / timeout failure', async () => {
    const { signer } = await buildFixtures();
    const client = {
      getInclusionProof: vi.fn(async () => {
        throw Object.assign(new Error('ETIMEDOUT'), { name: 'FetchError' });
      }),
    } as unknown as AggregatorClient;
    const reachable = await isReachable({
      signingPubKey: signer.signingPubKey,
      aggregatorClient: client,
    });
    expect(reachable).toBe(false);
  });
});
