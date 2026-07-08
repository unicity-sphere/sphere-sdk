/**
 * Aggregator probe (T-C2) — SPEC §8.1, §8.2.
 *
 * Wave 6-P2-16 migration: v2 SDK renamed `getInclusionProof(RequestId)` to
 * `getInclusionProof(StateId)` and returns `InclusionProofResponse` (with
 * `.inclusionProof` and `.blockNumber`). Verification moved off of the
 * `InclusionProof.verify(trustBase, requestId)` v1 method (which no longer
 * exists) to `InclusionProofVerificationRule.verify(trustBase,
 * predicateVerifier, proof, transaction)`.
 *
 * Three public entry points:
 *
 *   probeVersion(v)
 *     H2 OR-predicate. Returns true iff at least one side (A or B) has an
 *     inclusion certificate. Used by the Phase-1/Phase-2 discovery walk.
 *     Trust-base rotation is detected on verify failure (§8.4.1).
 *
 *   classifyVersion(v, ...)
 *     H1 four-way classifier. Returns VALID | SEMANTICALLY_INVALID |
 *     PROOF_TRANSIENT | CAR_TRANSIENT. Requires an injected IPFS/CAR
 *     fetcher.
 *
 *   isReachable(signingPubKey)
 *     Health check. Issues a getInclusionProof for the wallet's HEALTH_CHECK
 *     stateId and returns true iff the aggregator answered.
 */

import {
  AggregatorClient,
  DataHash,
  HashAlgorithm,
  InclusionProof,
  InclusionProofResponse,
  InclusionProofVerificationRule,
  InclusionProofVerificationStatus,
  PredicateVerifierService,
  RootTrustBase,
  StateId,
} from '../../../../token-engine/sdk.js';

import { PROBE_REQUEST_TIMEOUT_MS } from './constants.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import { deriveHealthCheckRequestId } from './health-check.js';
import { deriveStateHashDigest, deriveXorKey, type PointerKeyMaterial } from './key-derivation.js';
import { PointerTransaction } from './pointer-transaction.js';
import type { PointerSigner } from './signing.js';
import { raiseForTrustBaseMismatch } from './trust-base-rotation.js';
import { SIDE_A_NUM, SIDE_B_NUM, type PointerVersion } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Four-way version classification per H1 (SPEC §8.2 classifyVersion).
 *
 *   PROOF_TRANSIENT — the aggregator proof RPC failed (network/timeout).
 *                     Slot existence UNKNOWN — Phase 3 MUST NOT skip past.
 *
 *   CAR_TRANSIENT   — proof verified + CID decoded (slot EXISTS on-chain)
 *                     but IPFS gateways returned transient failure. Phase 3
 *                     MAY skip past under `skipUnfetchableInWalkback: true`.
 */
export type VersionClassification =
  | 'VALID'
  | 'SEMANTICALLY_INVALID'
  | 'PROOF_TRANSIENT'
  | 'CAR_TRANSIENT';

/**
 * Injected CAR fetch + deserialize callback for classifyVersion.
 */
export type CarFetchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'transient_unavailable' | 'content_mismatch' | 'car_parse_failed' };

export type CarFetcher = (cidBytes: Uint8Array) => Promise<CarFetchResult>;

export type CidDecodeResult =
  | { readonly ok: true; readonly cidBytes: Uint8Array }
  | { readonly ok: false };

export type CidDecoder = (full: Uint8Array) => CidDecodeResult;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Shared v2 predicate verifier — pointer only ever uses the default builtin set. */
const POINTER_PREDICATE_VERIFIER = PredicateVerifierService.create();

/**
 * Build the (stateId, tx) pair per side for version v.
 *
 * v2 replaces v1's `RequestId` with `StateId = hash(lockScript CBOR,
 * sourceStateHash)`. Side-effect: the stateId no longer directly encodes the
 * pubkey; it encodes the CBOR of the SignaturePredicate wrapping the pubkey
 * plus the derived sourceStateHash.
 *
 * Returns a `PointerTransaction` per side (without the transaction hash — the
 * caller fills that in from either the received proof's certificationData or
 * a locally-computed ct hash) plus the derived stateIds.
 */
async function buildProbeContext(
  keyMaterial: PointerKeyMaterial,
  signer: PointerSigner,
  v: PointerVersion,
): Promise<{
  stateIdA: StateId;
  stateIdB: StateId;
  stateHashA: DataHash;
  stateHashB: DataHash;
  probeTxA: PointerTransaction;
  probeTxB: PointerTransaction;
}> {
  const stateHashDigestA = deriveStateHashDigest(keyMaterial.xorSeed, SIDE_A_NUM, v);
  const stateHashDigestB = deriveStateHashDigest(keyMaterial.xorSeed, SIDE_B_NUM, v);
  try {
    const stateHashA = new DataHash(HashAlgorithm.SHA256, stateHashDigestA);
    const stateHashB = new DataHash(HashAlgorithm.SHA256, stateHashDigestB);
    const probeTxA = PointerTransaction.createForStateId(signer.signingPubKey, stateHashA);
    const probeTxB = PointerTransaction.createForStateId(signer.signingPubKey, stateHashB);
    const [stateIdA, stateIdB] = await Promise.all([
      StateId.fromTransaction(probeTxA),
      StateId.fromTransaction(probeTxB),
    ]);
    return { stateIdA, stateIdB, stateHashA, stateHashB, probeTxA, probeTxB };
  } finally {
    stateHashDigestA.fill(0);
    stateHashDigestB.fill(0);
  }
}

/** Fetch an inclusion-proof response with a hard timeout. */
async function fetchProofWithTimeout(
  client: AggregatorClient,
  stateId: StateId,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<InclusionProof> {
  if (abortSignal?.aborted) {
    const err = new Error('getInclusionProof aborted by caller');
    err.name = 'PointerProbeAborted';
    throw err;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`getInclusionProof timed out after ${timeoutMs}ms`);
      err.name = 'PointerProbeTimeout';
      reject(err);
    }, timeoutMs);
  });
  const abortPromise = abortSignal
    ? new Promise<never>((_, reject) => {
        abortListener = () => {
          const err = new Error('getInclusionProof aborted by caller');
          err.name = 'PointerProbeAborted';
          reject(err);
        };
        abortSignal.addEventListener('abort', abortListener, { once: true });
      })
    : null;
  try {
    const racers: Array<Promise<unknown>> = [client.getInclusionProof(stateId), timeoutPromise];
    if (abortPromise) racers.push(abortPromise);
    const response = (await Promise.race(racers)) as InclusionProofResponse | { inclusionProof?: unknown };
    // Shape guard: SDK drift (rename, added envelope, nullable shape) would
    // otherwise raise an unclassified TypeError. Explicitly reject with
    // PointerProtocolError so the caller surfaces a clear diagnostic.
    if (
      response === null ||
      typeof response !== 'object' ||
      !('inclusionProof' in response) ||
      response.inclusionProof === null ||
      response.inclusionProof === undefined
    ) {
      const err = new Error(
        `getInclusionProof response missing inclusionProof (SDK shape mismatch)`,
      );
      err.name = 'PointerProtocolError';
      throw err;
    }
    return response.inclusionProof as InclusionProof;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortListener && abortSignal) {
      abortSignal.removeEventListener('abort', abortListener);
    }
  }
}

/**
 * Verify an inclusion proof against a pointer transaction using v2's
 * `InclusionProofVerificationRule`. The pointer's synthetic transaction
 * needs its `transactionHash` to match the proof's `certificationData` —
 * so we rebuild the transaction using the proof's own transactionHash
 * before verifying (the pointer never "knows" the exact ct at probe time;
 * it only knows the stateId).
 *
 * Returns the {@link InclusionProofVerificationStatus} value.
 */
async function verifyPointerInclusionProof(
  trustBase: RootTrustBase,
  proof: InclusionProof,
  signingPubKey: Uint8Array,
  sourceStateHash: DataHash,
): Promise<InclusionProofVerificationStatus> {
  const cd = proof.certificationData;
  // If certificationData is null/undefined, verification will short-circuit
  // with MISSING_CERTIFICATION_DATA (or INCLUSION_CERTIFICATE_MISSING) —
  // pass a zero-hash transaction to satisfy the type contract; the rule's
  // own null checks will surface the correct status.
  const tx = PointerTransaction.create(
    signingPubKey,
    sourceStateHash,
    cd == null ? new DataHash(HashAlgorithm.SHA256, new Uint8Array(32)) : cd.transactionHash,
  );
  const result = await InclusionProofVerificationRule.verify(
    trustBase,
    POINTER_PREDICATE_VERIFIER,
    proof,
    tx,
  );
  return result.status;
}

// ── probeVersion (H2 OR-predicate) ─────────────────────────────────────────

export interface ProbeInput {
  readonly v: PointerVersion;
  readonly keyMaterial: PointerKeyMaterial;
  readonly signer: PointerSigner;
  readonly aggregatorClient: AggregatorClient;
  readonly trustBase: RootTrustBase;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

/**
 * Inclusion check for version v. Returns true iff at least one side (A or B)
 * has a trustlessly-verified inclusion proof (H2 OR-predicate).
 *
 * Verification failure (PATH_INVALID / NOT_AUTHENTICATED / INVALID_TRUSTBASE)
 * on EITHER side short-circuits to `raiseForTrustBaseMismatch` — the caller
 * gets either `TRUST_BASE_STALE` (legitimate rotation) or `UNTRUSTED_PROOF`
 * (forgery).
 *
 * INCLUSION_CERTIFICATE_MISSING on BOTH sides → returns false (legitimate
 * non-inclusion).
 */
export async function probeVersion(input: ProbeInput): Promise<boolean> {
  const { v, keyMaterial, signer, aggregatorClient, trustBase } = input;
  const timeoutMs = input.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS;

  const { stateIdA, stateIdB, stateHashA, stateHashB } = await buildProbeContext(keyMaterial, signer, v);
  const [proofA, proofB] = await Promise.all([
    fetchProofWithTimeout(aggregatorClient, stateIdA, timeoutMs, input.abortSignal),
    fetchProofWithTimeout(aggregatorClient, stateIdB, timeoutMs, input.abortSignal),
  ]);

  const [statusA, statusB] = await Promise.all([
    verifyPointerInclusionProof(trustBase, proofA, signer.signingPubKey, stateHashA),
    verifyPointerInclusionProof(trustBase, proofB, signer.signingPubKey, stateHashB),
  ]);

  // Integrity failures: NOT_AUTHENTICATED / PATH_INVALID / INVALID_TRUSTBASE
  // → rotation or forgery.
  if (isIntegrityFailure(statusA)) {
    raiseForTrustBaseMismatch(trustBase, proofA, `probeVersion(v=${v}, side=A)`);
  }
  if (isIntegrityFailure(statusB)) {
    raiseForTrustBaseMismatch(trustBase, proofB, `probeVersion(v=${v}, side=B)`);
  }

  const aIncluded = statusA === InclusionProofVerificationStatus.OK;
  const bIncluded = statusB === InclusionProofVerificationStatus.OK;

  return aIncluded || bIncluded;
}

function isIntegrityFailure(status: InclusionProofVerificationStatus): boolean {
  return (
    status === InclusionProofVerificationStatus.NOT_AUTHENTICATED ||
    status === InclusionProofVerificationStatus.PATH_INVALID ||
    status === InclusionProofVerificationStatus.INVALID_TRUSTBASE ||
    status === InclusionProofVerificationStatus.SHARD_ID_MISMATCH
  );
}

// ── classifyVersion (H1 four-way) ──────────────────────────────────────────

export interface ClassifyInput {
  readonly v: PointerVersion;
  readonly keyMaterial: PointerKeyMaterial;
  readonly signer: PointerSigner;
  readonly aggregatorClient: AggregatorClient;
  readonly trustBase: RootTrustBase;
  readonly decodeCid: CidDecoder;
  readonly fetchCar: CarFetcher;
  readonly timeoutMs?: number;
  readonly abortSignal?: AbortSignal;
}

/**
 * Shared Phase 1+2 primitive: fetch inclusion proofs + XOR-decode the
 * 64-byte plaintext + delegate CID parsing.
 */
type DecodePhaseOutcome =
  | { readonly ok: 'cid'; readonly cidBytes: Uint8Array }
  | { readonly ok: 'transient' }
  | { readonly ok: 'semantic' };

async function runDecodePhases(
  v: PointerVersion,
  keyMaterial: PointerKeyMaterial,
  signer: PointerSigner,
  aggregatorClient: AggregatorClient,
  trustBase: RootTrustBase,
  decodeCid: CidDecoder,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<DecodePhaseOutcome> {
  const { stateIdA, stateIdB, stateHashA, stateHashB } = await buildProbeContext(keyMaterial, signer, v);

  let proofA: InclusionProof;
  let proofB: InclusionProof;
  try {
    [proofA, proofB] = await Promise.all([
      fetchProofWithTimeout(aggregatorClient, stateIdA, timeoutMs, abortSignal),
      fetchProofWithTimeout(aggregatorClient, stateIdB, timeoutMs, abortSignal),
    ]);
  } catch (err) {
    if (err instanceof Error && err.name === 'PointerProtocolError') {
      throw new AggregatorPointerError(
        AggregatorPointerErrorCode.PROTOCOL_ERROR,
        err.message,
        undefined,
        { cause: err },
      );
    }
    return { ok: 'transient' };
  }

  const [statusA, statusB] = await Promise.all([
    verifyPointerInclusionProof(trustBase, proofA, signer.signingPubKey, stateHashA),
    verifyPointerInclusionProof(trustBase, proofB, signer.signingPubKey, stateHashB),
  ]);

  // Integrity failures: rotation or forgery.
  if (isIntegrityFailure(statusA)) {
    raiseForTrustBaseMismatch(trustBase, proofA, `classifyVersion(v=${v}, side=A)`);
  }
  if (isIntegrityFailure(statusB)) {
    raiseForTrustBaseMismatch(trustBase, proofB, `classifyVersion(v=${v}, side=B)`);
  }

  if (
    statusA !== InclusionProofVerificationStatus.OK ||
    statusB !== InclusionProofVerificationStatus.OK
  ) {
    return { ok: 'semantic' };
  }

  // Step 2: XOR-decode + CID parse (§8.2 step 2).
  // In v2, the ct bytes live on `certificationData.transactionHash.data`.
  const cdA = proofA.certificationData;
  const cdB = proofB.certificationData;
  if (cdA == null || cdB == null) {
    return { ok: 'semantic' };
  }
  const ctA = cdA.transactionHash.data;
  const ctB = cdB.transactionHash.data;
  if (ctA.length !== 32 || ctB.length !== 32) {
    return { ok: 'semantic' };
  }

  const xorKeyA = deriveXorKey(keyMaterial.xorSeed, SIDE_A_NUM, v);
  const xorKeyB = deriveXorKey(keyMaterial.xorSeed, SIDE_B_NUM, v);

  const full = new Uint8Array(64);
  try {
    for (let i = 0; i < 32; i++) full[i] = (ctA[i] ?? 0) ^ (xorKeyA[i] ?? 0);
    for (let i = 0; i < 32; i++) full[32 + i] = (ctB[i] ?? 0) ^ (xorKeyB[i] ?? 0);

    const decoded = decodeCid(full);
    if (!decoded.ok) {
      return { ok: 'semantic' };
    }
    return { ok: 'cid', cidBytes: new Uint8Array(decoded.cidBytes) };
  } finally {
    full.fill(0);
    xorKeyA.fill(0);
    xorKeyB.fill(0);
  }
}

export async function classifyVersion(input: ClassifyInput): Promise<VersionClassification> {
  const { v, keyMaterial, signer, aggregatorClient, trustBase, decodeCid, fetchCar } = input;
  const timeoutMs = input.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS;

  const phase12 = await runDecodePhases(
    v,
    keyMaterial,
    signer,
    aggregatorClient,
    trustBase,
    decodeCid,
    timeoutMs,
    input.abortSignal,
  );
  if (phase12.ok === 'transient') return 'PROOF_TRANSIENT';
  if (phase12.ok === 'semantic') return 'SEMANTICALLY_INVALID';

  const carResult = await fetchCar(phase12.cidBytes);
  if (carResult.ok) {
    return 'VALID';
  }
  switch (carResult.kind) {
    case 'transient_unavailable':
      return 'CAR_TRANSIENT';
    case 'content_mismatch':
    case 'car_parse_failed':
    default:
      return 'SEMANTICALLY_INVALID';
  }
}

// ── decodeVersionCid ───────────────────────────────────────────────────────

export interface DecodeVersionCidInput {
  readonly v: PointerVersion;
  readonly keyMaterial: PointerKeyMaterial;
  readonly signer: PointerSigner;
  readonly aggregatorClient: AggregatorClient;
  readonly trustBase: RootTrustBase;
  readonly decodeCid: CidDecoder;
  readonly timeoutMs?: number;
}

export type DecodeVersionCidResult =
  | { readonly ok: true; readonly cidBytes: Uint8Array }
  | { readonly ok: false; readonly reason: 'transient' | 'semantic' };

export async function decodeVersionCid(input: DecodeVersionCidInput): Promise<DecodeVersionCidResult> {
  const timeoutMs = input.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS;
  const outcome = await runDecodePhases(
    input.v,
    input.keyMaterial,
    input.signer,
    input.aggregatorClient,
    input.trustBase,
    input.decodeCid,
    timeoutMs,
  );
  if (outcome.ok === 'cid') {
    return { ok: true, cidBytes: outcome.cidBytes };
  }
  return { ok: false, reason: outcome.ok === 'transient' ? 'transient' : 'semantic' };
}

// ── isReachable (health check) ─────────────────────────────────────────────

export interface ReachableInput {
  readonly signingPubKey: Uint8Array;
  readonly aggregatorClient: AggregatorClient;
  readonly timeoutMs?: number;
}

/**
 * Aggregator health check (SPEC §11.12).
 *
 * The health-check request-id was derived in v1 as `SHA256(signingPubKey ||
 * [0x00, 0x00] || deriveHealthCheckRequestId(pubkey))`. In v2 we build a
 * synthetic PointerTransaction over the same 32-byte digest and use its
 * StateId — any response (including error) means the aggregator is reachable.
 */
export async function isReachable(input: ReachableInput): Promise<boolean> {
  const { signingPubKey, aggregatorClient } = input;
  const timeoutMs = input.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS;

  try {
    const digest = deriveHealthCheckRequestId(signingPubKey);
    const healthStateHash = new DataHash(HashAlgorithm.SHA256, digest);
    const tx = PointerTransaction.createForStateId(signingPubKey, healthStateHash);
    const healthStateId = await StateId.fromTransaction(tx);
    await fetchProofWithTimeout(aggregatorClient, healthStateId, timeoutMs);
    return true;
  } catch (err: unknown) {
    // JsonRpcNetworkError (5xx, 4xx) still means the aggregator answered.
    if (
      err !== null &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'JsonRpcNetworkError'
    ) {
      return true;
    }
    // JsonRpcDataError — reachable.
    if (
      err !== null &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'JsonRpcError'
    ) {
      return true;
    }
    return false;
  }
}

// ── Test-only exports ──────────────────────────────────────────────────────

export const __internal = {
  buildProbeContext,
  fetchProofWithTimeout,
  runDecodePhases,
  verifyPointerInclusionProof,
  isIntegrityFailure,
};
