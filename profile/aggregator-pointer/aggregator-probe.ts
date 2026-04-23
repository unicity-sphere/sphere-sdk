/**
 * Aggregator probe (T-C2) — SPEC §8.1, §8.2.
 *
 * Three public entry points:
 *
 *   probeVersion(v)
 *     H2 OR-predicate. Returns true iff at least one side (A or B) has a
 *     verified inclusion proof. Used by the Phase-1/Phase-2 discovery walk.
 *     Trust-base rotation is detected on verify failure (§8.4.1).
 *
 *   classifyVersion(v, ...)
 *     H1 three-way classifier. Returns VALID | SEMANTICALLY_INVALID |
 *     TRANSIENT_UNAVAILABLE. Used by Phase-3 walkback. Requires an
 *     injected IPFS/CAR fetcher (the pointer layer does not own IPFS
 *     itself — that stays in profile/ipfs-client.ts).
 *
 *   isReachable(signingPubKey)
 *     Health check. Issues a getInclusionProof for the wallet's HEALTH_CHECK
 *     request id (SPEC §11.12) and returns true iff the aggregator answered
 *     (status is irrelevant — the request is not expected to be included).
 *     Used by BLOCKED-state CLEAR paths (SPEC §10.2).
 *
 * No side-channel leakage: timing does not depend on which side verified.
 */

import type { AggregatorClient } from '@unicitylabs/state-transition-sdk/lib/api/AggregatorClient.js';
import { RequestId } from '@unicitylabs/state-transition-sdk/lib/api/RequestId.js';
import { DataHash } from '@unicitylabs/state-transition-sdk/lib/hash/DataHash.js';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm.js';
import { InclusionProofVerificationStatus } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import type { InclusionProof } from '@unicitylabs/state-transition-sdk/lib/transaction/InclusionProof.js';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase.js';

import { PROBE_REQUEST_TIMEOUT_MS } from './constants.js';
import { AggregatorPointerError, AggregatorPointerErrorCode } from './errors.js';
import { deriveHealthCheckRequestId } from './health-check.js';
import { deriveStateHashDigest, deriveXorKey, type PointerKeyMaterial } from './key-derivation.js';
import type { PointerSigner } from './signing.js';
import { raiseForTrustBaseMismatch } from './trust-base-rotation.js';
import { SIDE_A_NUM, SIDE_B_NUM, type PointerVersion } from './types.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** Three-way version classification per H1 (SPEC §8.2 classifyVersion). */
export type VersionClassification =
  | 'VALID'
  | 'SEMANTICALLY_INVALID'
  | 'TRANSIENT_UNAVAILABLE';

/**
 * Injected CAR fetch + deserialize callback for classifyVersion.
 *
 * Returns:
 *   - `{ ok: true }` on successful content-address-verified CAR deserialization
 *   - `{ ok: false, kind: 'transient_unavailable' }` when all gateways return
 *     network errors / timeouts / 5xx
 *   - `{ ok: false, kind: 'content_mismatch' }` on CID hash mismatch
 *   - `{ ok: false, kind: 'car_parse_failed' }` on structural CAR failure
 */
export type CarFetchResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: 'transient_unavailable' | 'content_mismatch' | 'car_parse_failed' };

export type CarFetcher = (cidBytes: Uint8Array) => Promise<CarFetchResult>;

/**
 * Injected CID decoder — reconstructs cidBytes from the two 32-byte halves
 * (partA || partB) after XOR-decode. Throws on length-prefix violation, bad
 * varints, or out-of-bounds.
 *
 * The pointer layer does not own CID multiformat parsing — the caller supplies
 * a decoder that returns either:
 *   - `{ ok: true, cidBytes: Uint8Array }` on structural success
 *   - `{ ok: false }` on any semantic failure (treated as SEMANTICALLY_INVALID)
 */
export type CidDecodeResult =
  | { readonly ok: true; readonly cidBytes: Uint8Array }
  | { readonly ok: false };

export type CidDecoder = (full: Uint8Array) => CidDecodeResult;

// ── Helpers ────────────────────────────────────────────────────────────────

/** Compute both requestIds for version v (sides A and B) in parallel. */
async function buildRequestIds(
  keyMaterial: PointerKeyMaterial,
  signer: PointerSigner,
  v: PointerVersion,
): Promise<{ reqA: RequestId; reqB: RequestId; stateHashA: DataHash; stateHashB: DataHash }> {
  const stateHashDigestA = deriveStateHashDigest(keyMaterial.xorSeed, SIDE_A_NUM, v);
  const stateHashDigestB = deriveStateHashDigest(keyMaterial.xorSeed, SIDE_B_NUM, v);
  try {
    const stateHashA = new DataHash(HashAlgorithm.SHA256, stateHashDigestA);
    const stateHashB = new DataHash(HashAlgorithm.SHA256, stateHashDigestB);
    const [reqA, reqB] = await Promise.all([
      RequestId.createFromImprint(signer.signingPubKey, stateHashA.imprint),
      RequestId.createFromImprint(signer.signingPubKey, stateHashB.imprint),
    ]);
    return { reqA, reqB, stateHashA, stateHashB };
  } finally {
    // The state-hash digests are not secret per se (they are derived from
    // xorSeed and appear in requestIds anyway) but we zero them for
    // defense-in-depth consistency with the submit path.
    stateHashDigestA.fill(0);
    stateHashDigestB.fill(0);
  }
}

/** Fetch an inclusion-proof response with a hard timeout. */
async function fetchProofWithTimeout(
  client: AggregatorClient,
  requestId: RequestId,
  timeoutMs: number,
): Promise<InclusionProof> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      const err = new Error(`getInclusionProof timed out after ${timeoutMs}ms`);
      err.name = 'PointerProbeTimeout';
      reject(err);
    }, timeoutMs);
  });
  try {
    const response = await Promise.race([client.getInclusionProof(requestId), timeoutPromise]);
    // Shape guard: SDK drift (rename, added envelope, nullable shape) would
    // otherwise raise an unclassified TypeError that the outer try/catch in
    // classifyVersion buckets as 'transient'. That's wrong for a permanent
    // SDK-shape breakage. Explicitly reject with PROTOCOL_ERROR so the
    // caller surfaces a clear diagnostic instead of a silent retry loop.
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
    return response.inclusionProof;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

// ── probeVersion (H2 OR-predicate) ─────────────────────────────────────────

export interface ProbeInput {
  readonly v: PointerVersion;
  readonly keyMaterial: PointerKeyMaterial;
  readonly signer: PointerSigner;
  readonly aggregatorClient: AggregatorClient;
  readonly trustBase: RootTrustBase;
  readonly timeoutMs?: number;
}

/**
 * Inclusion check for version v. Returns true iff at least one side (A or B)
 * has a trustlessly-verified inclusion proof (H2 OR-predicate).
 *
 * Verification failure (PATH_INVALID / NOT_AUTHENTICATED) on EITHER side
 * short-circuits to `raiseForTrustBaseMismatch` — the caller gets either
 * `TRUST_BASE_STALE` (legitimate rotation) or `UNTRUSTED_PROOF` (forgery).
 *
 * PATH_NOT_INCLUDED on BOTH sides → returns false (legitimate non-inclusion).
 */
export async function probeVersion(input: ProbeInput): Promise<boolean> {
  const { v, keyMaterial, signer, aggregatorClient, trustBase } = input;
  const timeoutMs = input.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS;

  const { reqA, reqB } = await buildRequestIds(keyMaterial, signer, v);
  const [proofA, proofB] = await Promise.all([
    fetchProofWithTimeout(aggregatorClient, reqA, timeoutMs),
    fetchProofWithTimeout(aggregatorClient, reqB, timeoutMs),
  ]);

  const [statusA, statusB] = await Promise.all([
    proofA.verify(trustBase, reqA),
    proofB.verify(trustBase, reqB),
  ]);

  // Integrity failures: NOT_AUTHENTICATED / PATH_INVALID → rotation or forgery.
  if (
    statusA === InclusionProofVerificationStatus.NOT_AUTHENTICATED ||
    statusA === InclusionProofVerificationStatus.PATH_INVALID
  ) {
    raiseForTrustBaseMismatch(trustBase, proofA, `probeVersion(v=${v}, side=A)`);
  }
  if (
    statusB === InclusionProofVerificationStatus.NOT_AUTHENTICATED ||
    statusB === InclusionProofVerificationStatus.PATH_INVALID
  ) {
    raiseForTrustBaseMismatch(trustBase, proofB, `probeVersion(v=${v}, side=B)`);
  }

  const aIncluded = statusA === InclusionProofVerificationStatus.OK;
  const bIncluded = statusB === InclusionProofVerificationStatus.OK;

  return aIncluded || bIncluded;
}

// ── classifyVersion (H1 three-way) ─────────────────────────────────────────

export interface ClassifyInput {
  readonly v: PointerVersion;
  readonly keyMaterial: PointerKeyMaterial;
  readonly signer: PointerSigner;
  readonly aggregatorClient: AggregatorClient;
  readonly trustBase: RootTrustBase;
  /** Reconstructs cidBytes from the decoded 64-byte plaintext. */
  readonly decodeCid: CidDecoder;
  /** Fetches and content-address-verifies the CAR from IPFS. */
  readonly fetchCar: CarFetcher;
  readonly timeoutMs?: number;
}

/**
 * Shared Phase 1+2 primitive: fetch inclusion proofs + XOR-decode the
 * 64-byte plaintext + delegate CID parsing. Consumed by both
 * `classifyVersion` (which then does Phase 3 CAR verify) and
 * `decodeVersionCid` (used by the Phase-D `resolveRemoteCid` callback
 * after discovery has already classified the version).
 *
 * Emits one of three outcomes:
 *   - `{ ok: 'cid', cidBytes }` — proofs verified, CID decoded
 *   - `{ ok: 'transient' }`     — proof fetch failed (network-class)
 *   - `{ ok: 'semantic' }`      — partial inclusion, malformed CT, or
 *                                 CID decoder rejected the plaintext
 *
 * Trust-base rotation / forgery (`NOT_AUTHENTICATED`, `PATH_INVALID`)
 * short-circuits to `raiseForTrustBaseMismatch` and throws — the
 * caller always sees either one of the three outcomes or a thrown
 * `AggregatorPointerError`.
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
): Promise<DecodePhaseOutcome> {
  // Step 1: both inclusion proofs (§8.2 step 1).
  const { reqA, reqB } = await buildRequestIds(keyMaterial, signer, v);

  let proofA: InclusionProof;
  let proofB: InclusionProof;
  try {
    [proofA, proofB] = await Promise.all([
      fetchProofWithTimeout(aggregatorClient, reqA, timeoutMs),
      fetchProofWithTimeout(aggregatorClient, reqB, timeoutMs),
    ]);
  } catch (err) {
    // Discriminate on error class:
    //   PointerProtocolError — SDK shape drift (missing inclusionProof
    //     field in getInclusionProof response). This is a DETERMINISTIC
    //     failure — the aggregator/SDK combination will fail identically
    //     on every retry. Surface it as AggregatorPointerError with
    //     PROTOCOL_ERROR so classifyVersion / recoverLatest / publish
    //     callers see a stable error code, not a transient-class retry.
    //   Everything else — network failure, timeout, serialization error.
    //     Transient by design; caller retries.
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
    proofA.verify(trustBase, reqA),
    proofB.verify(trustBase, reqB),
  ]);

  // Integrity failures: rotation or forgery.
  if (
    statusA === InclusionProofVerificationStatus.NOT_AUTHENTICATED ||
    statusA === InclusionProofVerificationStatus.PATH_INVALID
  ) {
    raiseForTrustBaseMismatch(trustBase, proofA, `classifyVersion(v=${v}, side=A)`);
  }
  if (
    statusB === InclusionProofVerificationStatus.NOT_AUTHENTICATED ||
    statusB === InclusionProofVerificationStatus.PATH_INVALID
  ) {
    raiseForTrustBaseMismatch(trustBase, proofB, `classifyVersion(v=${v}, side=B)`);
  }

  // Both sides required for a full XOR decode. A missing side yields
  // SEMANTICALLY_INVALID (the XOR plaintext would be truncated).
  if (
    statusA !== InclusionProofVerificationStatus.OK ||
    statusB !== InclusionProofVerificationStatus.OK
  ) {
    return { ok: 'semantic' };
  }

  // Step 2: XOR-decode + CID parse (§8.2 step 2).
  //
  // The proof's transactionHash.data is the ctSide ciphertext (per §6.3).
  // We XOR with the deterministic xorKey to recover the 32-byte half, then
  // concatenate to form the 64-byte `full` buffer and delegate CID parsing.
  const txHashA = proofA.transactionHash;
  const txHashB = proofB.transactionHash;
  if (txHashA === null || txHashB === null) {
    return { ok: 'semantic' };
  }
  const ctA = txHashA.data;
  const ctB = txHashB.data;
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
    // Copy out — caller keeps the CID bytes; `full` is zeroed in
    // `finally`. `decoded.cidBytes` may alias a buffer backed by the
    // multiformats lib; we clone so the consumer owns a stable slice.
    return { ok: 'cid', cidBytes: new Uint8Array(decoded.cidBytes) };
  } finally {
    full.fill(0);
    xorKeyA.fill(0);
    xorKeyB.fill(0);
  }
}

/**
 * Three-way classify per SPEC §8.2 classifyVersion helper:
 *   VALID                 — both sides verified + CID parseable + CAR fetched
 *   SEMANTICALLY_INVALID  — proof partial, CID corrupt, or CAR fails content-address
 *   TRANSIENT_UNAVAILABLE — all IPFS gateways transient-fail; tokens may still exist
 *
 * classifyVersion requires BOTH sides included (stricter than probe's OR).
 */
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
  );
  if (phase12.ok === 'transient') return 'TRANSIENT_UNAVAILABLE';
  if (phase12.ok === 'semantic') return 'SEMANTICALLY_INVALID';

  // Step 3: fetch + content-address verify (§8.2 step 3).
  const carResult = await fetchCar(phase12.cidBytes);
  if (carResult.ok) {
    return 'VALID';
  }
  switch (carResult.kind) {
    case 'transient_unavailable':
      return 'TRANSIENT_UNAVAILABLE';
    case 'content_mismatch':
    case 'car_parse_failed':
    default:
      return 'SEMANTICALLY_INVALID';
  }
}

// ── decodeVersionCid ───────────────────────────────────────────────────────

/**
 * Phase 1+2 of classifyVersion, exposed standalone.
 *
 * Used by `ProfilePointerLayer.recoverLatest()`'s `resolveRemoteCid`
 * callback: discovery has already certified the version as VALID
 * (via an earlier classifyVersion pass), so the caller only needs the
 * CID bytes without re-running the CAR fetch. Skipping Phase 3 avoids
 * a second IPFS round-trip on the happy path.
 *
 * Semantic and transient failures map 1:1 onto pointer-layer error
 * codes so the caller can propagate a clear diagnostic.
 */
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
 * Issues a getInclusionProof for the wallet's HEALTH_CHECK request id (deterministic
 * derivation of a request id guaranteed NOT to be in the SMT). The aggregator
 * should respond with PATH_NOT_INCLUDED; we treat any well-formed response
 * (even PATH_NOT_INCLUDED / NOT_AUTHENTICATED) as "reachable".
 *
 * Only network-level failures (timeout, DNS, TLS, 5xx) indicate unreachability.
 */
export async function isReachable(input: ReachableInput): Promise<boolean> {
  const { signingPubKey, aggregatorClient } = input;
  const timeoutMs = input.timeoutMs ?? PROBE_REQUEST_TIMEOUT_MS;

  try {
    // deriveHealthCheckRequestId returns the raw 32-byte digest. We wrap it
    // in a RequestId by constructing the 34-byte SHA-256 imprint
    // ([0x00, 0x00, ...digest]) and hex-encoding it for RequestId.fromJSON.
    const digest = deriveHealthCheckRequestId(signingPubKey);
    const imprint = new Uint8Array(34);
    imprint[0] = 0x00;
    imprint[1] = 0x00;
    imprint.set(digest, 2);
    let hex = '';
    for (const b of imprint) hex += b.toString(16).padStart(2, '0');
    const healthCheckRequestId = RequestId.fromJSON(hex);
    await fetchProofWithTimeout(aggregatorClient, healthCheckRequestId, timeoutMs);
    // Any response (including PATH_NOT_INCLUDED) means the aggregator is
    // reachable and responsive. No .verify() call — the semantic outcome is
    // irrelevant.
    return true;
  } catch (err: unknown) {
    // JsonRpcNetworkError (5xx, 4xx) is still a response — the aggregator is
    // reachable, just unhappy. Treat those as reachable.
    if (
      err !== null &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'JsonRpcNetworkError'
    ) {
      return true;
    }
    // JsonRpcDataError (JSON-RPC-level error) — reachable.
    if (
      err !== null &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'JsonRpcError'
    ) {
      return true;
    }
    // Genuine network / timeout failures → unreachable.
    return false;
  }
}

// ── Test-only exports ──────────────────────────────────────────────────────

export const __internal = {
  buildRequestIds,
  fetchProofWithTimeout,
  runDecodePhases,
};
