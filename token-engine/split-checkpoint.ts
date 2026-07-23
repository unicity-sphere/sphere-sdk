/**
 * token-engine/split-checkpoint.ts — the split burn checkpoint (sdk-changes E.4, sphere-sdk#501
 * option b). Encodes/decodes the one split-resume input the engine cannot re-derive — the burn's
 * aggregator-issued inclusion proof — and rebuilds the burnt token from STORED bytes so every
 * mint justification is byte-stable across a resume (the aggregator regenerates proofs per
 * request; only `CertificationData` is stable).
 *
 * Payload (strict-canonical CBOR array): `[v, sdkVersion, burnTx.toCBOR(), burnProof.toCBOR(),
 * sha256(burntToken.toCBOR())]`. Storing the burn-tx bytes turns any cross-version derivation
 * drift into a LOUD byte-inequality; the burnt-token hash catches a tolerant-decode wire migration
 * on resume. The engine passes PLAINTEXT through the `SplitCheckpointStore` port; AAD-encryption is
 * the transport adapter's concern.
 */

import { SplitCheckpointLostError, CheckpointTrustbaseMismatchError } from './errors';
import {
  CborDeserializer,
  CborSerializer,
  DataHasher,
  HashAlgorithm,
  InclusionProof,
  InclusionProofVerificationStatus,
  type PredicateVerifierService,
  type RootTrustBase,
  Token,
  type TransferTransaction,
  type VerificationContext,
} from './sdk';

/** Checkpoint payload version (the CBOR array's first element). */
const CHECKPOINT_VERSION = 1;
/**
 * The base-SDK pin whose CBOR wire form governs byte-stability — recorded for a LOUD drift
 * diagnosis only (byte-inequality of the stored burn tx is the actual guard). Bump with the pin.
 */
const CHECKPOINT_SDK_VERSION = '@unicitylabs/state-transition-sdk@2.0.1';

export interface CheckpointDeps {
  readonly trustBase: RootTrustBase;
  readonly predicateVerifier: PredicateVerifierService;
  readonly verificationContext: VerificationContext;
}

/** Constant-length-agnostic byte-equality (no early-exit timing concern — these are public bytes). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return (await new DataHasher(HashAlgorithm.SHA256).update(bytes).digest()).imprint;
}

/**
 * Encode the checkpoint for `store.put`. `burntToken` is the freshly-built burnt token whose hash
 * pins the resume-side re-encode equality check.
 */
export async function encodeCheckpoint(
  burnTx: TransferTransaction,
  burnProof: InclusionProof,
  burntToken: Token,
): Promise<Uint8Array> {
  return CborSerializer.encodeArray(
    CborSerializer.encodeUnsignedInteger(CHECKPOINT_VERSION),
    CborSerializer.encodeTextString(CHECKPOINT_SDK_VERSION),
    CborSerializer.encodeByteString(burnTx.toCBOR()),
    CborSerializer.encodeByteString(burnProof.toCBOR()),
    CborSerializer.encodeByteString(await sha256(burntToken.toCBOR())),
  );
}

interface DecodedCheckpoint {
  readonly sdkVersion: string;
  readonly burnTxBytes: Uint8Array;
  readonly burnProofBytes: Uint8Array;
  readonly burntTokenHash: Uint8Array;
}

/**
 * Decode a stored checkpoint; ANY malformed/unknown-version record is a lost checkpoint (never
 * mint). The FULL decode (array framing AND every inner field) is guarded — a well-framed 5-array
 * with a wrong-typed/non-canonical inner field throws a raw `CborError` from the per-field decoders,
 * which must still surface as the typed keep-open error, not escape `split()` untyped (AC-E6(c)).
 */
function decodeCheckpoint(bytes: Uint8Array): DecodedCheckpoint {
  try {
    const fields = CborDeserializer.decodeArray(bytes, 5);
    const version = Number(CborDeserializer.decodeUnsignedInteger(fields[0]));
    if (version !== CHECKPOINT_VERSION) {
      throw new SplitCheckpointLostError(`split checkpoint version ${String(version)} is not supported`);
    }
    return {
      sdkVersion: CborDeserializer.decodeTextString(fields[1]),
      burnTxBytes: CborDeserializer.decodeByteString(fields[2]),
      burnProofBytes: CborDeserializer.decodeByteString(fields[3]),
      burntTokenHash: CborDeserializer.decodeByteString(fields[4]),
    };
  } catch (err) {
    if (err instanceof SplitCheckpointLostError) throw err;
    throw new SplitCheckpointLostError('split checkpoint is malformed (cannot decode)', err);
  }
}

/** Classify a `toCertifiedTransaction` failure: only INVALID_TRUSTBASE is a keep-open drain case. */
function isTrustbaseFailure(err: unknown): boolean {
  const status = (err as { verificationResult?: { status?: unknown } })?.verificationResult?.status;
  return status === InclusionProofVerificationStatus.INVALID_TRUSTBASE;
}

/**
 * Rebuild the burnt token from a stored checkpoint (resume, or adopt-after-put). NEVER refetches
 * the burn proof — it applies the STORED proof to the re-derived burn tx, so the mint
 * justification is byte-stable. Throws (never returns a wrong burnt token):
 * - stored burn tx ≠ re-derived (cross-version drift)      → SplitCheckpointLostError (names sdkVersion)
 * - stored proof fails ONLY the current trust base         → CheckpointTrustbaseMismatchError
 * - stored proof otherwise invalid / corrupt               → SplitCheckpointLostError
 * - rebuilt burnt token re-encodes to a different hash      → SplitCheckpointLostError (wire migration)
 */
export async function burntTokenFromCheckpoint(
  deps: CheckpointDeps,
  storedBytes: Uint8Array,
  reDerivedBurnTx: TransferTransaction,
  sourceToken: Token,
): Promise<Token> {
  const decoded = decodeCheckpoint(storedBytes);
  if (!bytesEqual(decoded.burnTxBytes, reDerivedBurnTx.toCBOR())) {
    throw new SplitCheckpointLostError(
      `split checkpoint burn tx does not match the re-derived burn (stored under ${decoded.sdkVersion}) — derivation drift`,
    );
  }
  // The burn-proof field is the most transit-exposed value; parsing corrupt bytes throws a raw
  // CborError, which must surface as the typed keep-open error (not escape split() untyped).
  let burnProof: InclusionProof;
  try {
    burnProof = InclusionProof.fromCBOR(decoded.burnProofBytes);
  } catch (err) {
    throw new SplitCheckpointLostError('split checkpoint proof is malformed (cannot decode)', err);
  }
  let burnCertified;
  try {
    burnCertified = await reDerivedBurnTx.toCertifiedTransaction(deps.trustBase, deps.predicateVerifier, burnProof);
  } catch (err) {
    if (isTrustbaseFailure(err)) {
      throw new CheckpointTrustbaseMismatchError(
        'split checkpoint proof no longer verifies against the current trust base (validator rotation)',
        err,
      );
    }
    throw new SplitCheckpointLostError('split checkpoint proof is invalid', err);
  }
  // Defense-in-depth: the inputs are pre-validated (byte-equal burn tx + trustbase-verified proof),
  // so this application is effectively unreachable-throwing — but keep the whole resume path free of
  // raw-error escapes (a future wire migration must still surface the typed keep-open error).
  let burntToken: Token;
  try {
    burntToken = await sourceToken.transfer(burnCertified, deps.verificationContext);
  } catch (err) {
    throw new SplitCheckpointLostError('split checkpoint could not rebuild the burnt token', err);
  }
  if (!bytesEqual(await sha256(burntToken.toCBOR()), decoded.burntTokenHash)) {
    throw new SplitCheckpointLostError('split checkpoint burnt-token hash mismatch (wire re-encoding drift)');
  }
  return burntToken;
}
