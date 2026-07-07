/**
 * #207 PR-B — V5-pending synthetic token-shape helpers.
 *
 * Two pure functions:
 *
 *   - `buildSyntheticV5PendingSdkData(bundle, pendingData)` — produces the
 *     UXF/TXF-valid sdkData JSON string for a V5-pending token. Mirrors the
 *     shape that `finalizeFromV5Bundle()` produces post-finalization but
 *     with `inclusionProof: null` on both genesis (mint not yet proven)
 *     and the synthetic transfer transaction (transfer commitment not yet
 *     proven). Returns `null` on parse failure — caller falls back to the
 *     legacy opaque `{ _pendingFinalization: ... }` shape.
 *
 *   - `readV5FinalizationInputsFromToken(sdkData)` — extracts the fields
 *     needed by `resolveV5Token` from a token's sdkData (the synthetic
 *     shape). Returns `null` if the token doesn't have the synthetic
 *     shape; caller falls back to parsing `pending.bundleJson`.
 *
 * Extracted from PaymentsModule.ts:6226-6288 (IIFE) for unit testability.
 */
import type { IAuthenticatorJson } from 'stsdk-v1/lib/api/Authenticator';
import type { IMintTransactionDataJson } from 'stsdk-v1/lib/transaction/MintTransactionData';
import type { ITransferTransactionDataJson } from 'stsdk-v1/lib/transaction/TransferTransactionData';
import type { ITokenStateJson } from 'stsdk-v1/lib/token/TokenState';
import type { InstantSplitBundleV5, PendingV5Finalization } from '../../../types/instant-split';

/**
 * Canonical JSON shape of `TransferCommitment.toJSON()`. Re-declared here
 * because the SDK does not export the interface (only the class).
 */
export interface ITransferCommitmentJson {
  readonly requestId: string;
  readonly transactionData: ITransferTransactionDataJson;
  readonly authenticator: IAuthenticatorJson;
}

/**
 * Inputs `resolveV5Token` needs to drive finalization. Sourced from the
 * synthetic token shape directly (preferred) or by parsing the legacy
 * `pending.bundleJson` (back-compat for entries persisted pre-#207).
 */
export interface V5FinalizationInputs {
  /** Recipient mint transaction data — `MintTransactionData.fromJSON(this)` */
  readonly mintDataJson: IMintTransactionDataJson;
  /**
   * Transfer commitment JSON suitable for
   * `TransferCommitment.fromJSON({ requestId, transactionData, authenticator })`.
   * When sourced from the token shape, `requestId` is derived at submit
   * time from `authenticator.publicKey` + `authenticator.stateHash` and
   * is NOT carried here. Callers use the helper
   * {@link buildTransferCommitmentJson} to construct the canonical JSON.
   */
  readonly transferTransactionDataJson: ITransferTransactionDataJson;
  readonly transferAuthenticatorJson: IAuthenticatorJson;
  /** Minted token state JSON — used to reconstruct the intermediate sender-owned token. */
  readonly mintedTokenStateJson: ITokenStateJson;
  /** Token type hex — derivable from mintDataJson.tokenType. */
  readonly tokenTypeHex: string;
  /** Transfer salt hex — derivable from transferTransactionDataJson.salt. */
  readonly transferSaltHex: string;
  /** Recipient address (DIRECT://... or PROXY://...). */
  readonly recipientAddress: string;
}

/**
 * Synthetic token shape produced by {@link buildSyntheticV5PendingSdkData}.
 * Exported for the shape-reader and unit tests.
 */
export interface SyntheticV5PendingTxf {
  readonly version: '2.0';
  readonly state: ITokenStateJson;
  readonly genesis: {
    readonly data: IMintTransactionDataJson;
    readonly inclusionProof: null;
  };
  readonly transactions: ReadonlyArray<{
    readonly data: ITransferTransactionDataJson;
    readonly inclusionProof: null;
    readonly _wallet?: { readonly authenticator: IAuthenticatorJson };
  }>;
  readonly nametags: ReadonlyArray<unknown>;
  readonly _pendingFinalization?: PendingV5Finalization;
  readonly _integrity?: { readonly currentStateHash: string };
}

/**
 * Result of {@link buildSyntheticV5PendingSdkData}. Discriminated by `ok`.
 * On failure the `error` field carries a short reason for the log line —
 * the caller's fallback warning embeds it so post-hoc diagnosis of
 * silent regressions is possible.
 */
export type BuildSyntheticResult =
  | { readonly ok: true; readonly sdkData: string }
  | { readonly ok: false; readonly error: string };

/**
 * Construct the UXF/TXF-valid sdkData for a V5-pending token from a V5
 * bundle. Returns `{ok: true, sdkData}` on success, `{ok: false,
 * error}` if the bundle is malformed (caller logs + falls back to the
 * legacy opaque shape).
 *
 * The transfer commitment's authenticator rides as
 * `transactions[0]._wallet.authenticator` so it survives UXF round-trip
 * via the new `pending-authenticator` element type (#202 schema).
 *
 * `_integrity.currentStateHash` is set from the transfer authenticator's
 * `stateHash` (= the source state hash of the transfer = hash of the
 * minted token state). The wallet's (tokenId, stateHash) dedup index
 * uses this for stable identity across save/load.
 */
export function buildSyntheticV5PendingSdkData(
  bundle: InstantSplitBundleV5,
  pendingData: PendingV5Finalization,
): BuildSyntheticResult {
  try {
    const mintDataJson = JSON.parse(bundle.recipientMintData) as IMintTransactionDataJson;
    const transferCommitmentJson = JSON.parse(bundle.transferCommitment) as ITransferCommitmentJson;
    const mintedTokenState = JSON.parse(bundle.mintedTokenStateJson) as ITokenStateJson;

    // The on-chain transactionData lives under either `transactionData`
    // (canonical) or `data` (legacy). Tolerate both for safety.
    const transferTxData =
      transferCommitmentJson.transactionData !== undefined
        ? transferCommitmentJson.transactionData
        : ((transferCommitmentJson as unknown as { data?: ITransferTransactionDataJson }).data
            ?? null);

    if (transferTxData === null) {
      return { ok: false, error: 'transferCommitment missing transactionData (and legacy data)' };
    }

    const transferAuth: IAuthenticatorJson | undefined =
      transferCommitmentJson.authenticator
        && typeof transferCommitmentJson.authenticator === 'object'
        ? transferCommitmentJson.authenticator
        : undefined;

    const currentStateHash: string | undefined =
      transferAuth && typeof transferAuth.stateHash === 'string'
        ? transferAuth.stateHash
        : undefined;

    const syntheticPendingTx: {
      data: ITransferTransactionDataJson;
      inclusionProof: null;
      _wallet?: { authenticator: IAuthenticatorJson };
    } = {
      data: transferTxData,
      inclusionProof: null,
    };
    if (transferAuth !== undefined) {
      syntheticPendingTx._wallet = { authenticator: transferAuth };
    }

    const syntheticTxf: SyntheticV5PendingTxf & {
      _pendingFinalization: PendingV5Finalization;
      _integrity?: { currentStateHash: string };
    } = {
      version: '2.0',
      state: mintedTokenState,
      genesis: {
        data: mintDataJson,
        inclusionProof: null,
      },
      transactions: [syntheticPendingTx],
      nametags: [],
      _pendingFinalization: pendingData,
    };
    if (currentStateHash !== undefined) {
      syntheticTxf._integrity = { currentStateHash };
    }

    return { ok: true, sdkData: JSON.stringify(syntheticTxf) };
  } catch (err) {
    return { ok: false, error: (err as Error)?.message ?? String(err) };
  }
}

/**
 * Reconstruct the canonical `TransferCommitment.toJSON()` shape from the
 * synthetic token's transfer transaction data + authenticator.
 *
 * `TransferCommitment.fromJSON` requires `{requestId, transactionData,
 * authenticator}`. The `requestId` is deterministically derivable from
 * `authenticator.publicKey` + `authenticator.stateHash` via
 * `RequestId.create(publicKey, stateHash)`. We pass the empty-string
 * sentinel here and let the caller derive it via RequestId.create —
 * inlining requires SDK side-effects we don't want in a pure helper.
 *
 * In practice callers don't need this helper because the synthetic
 * shape's authenticator carries the same fields. Kept as a placeholder
 * for the documentation of the shape mapping.
 */
export function buildTransferCommitmentJson(
  transactionData: ITransferTransactionDataJson,
  authenticator: IAuthenticatorJson,
  requestId: string,
): ITransferCommitmentJson {
  return { requestId, transactionData, authenticator };
}

/** Length of a compressed secp256k1 pubkey in hex characters (33 bytes × 2). */
const SECP256K1_PUBKEY_HEX_LEN = 66;
/** Hex regex (any case, any length ≥ 1). */
const HEX_RE = /^[0-9a-fA-F]+$/;

/**
 * Read V5 finalization inputs from the synthetic token shape.
 *
 * Returns `null` if any of the following hold:
 *   - sdkData is not parseable as JSON or is not an object
 *   - `genesis` is absent OR `genesis.inclusionProof` is non-null
 *     (defense: if the mint is already proven, the shape-driven
 *     re-submission path is unsafe — the legacy bundleJson path or a
 *     normal load-time finalize should handle the token)
 *   - `genesis.data` is missing or doesn't carry well-formed hex
 *     `tokenId` / `tokenType`
 *   - `transactions[0]` is absent OR its inclusionProof is non-null
 *   - `transactions[0].data` is missing recipient (non-empty string)
 *     or salt (hex string)
 *   - `transactions[0]._wallet.authenticator` is missing OR has a
 *     malformed shape (wrong types, non-hex fields, wrong publicKey
 *     byte-length for secp256k1)
 *
 * Callers fall back to parsing `pending.bundleJson` on null.
 *
 * #207 PR-B steelman — Pre-validation here means the downstream
 * `Authenticator.fromJSON` / `MintTransactionData.fromJSON` calls in
 * `resolveV5Token` only ever see well-formed input. A structural
 * defect (wrong key length, missing field, etc.) returns null here so
 * the caller falls back to bundleJson instead of crashing inside the
 * SDK and burning attemptCount budget.
 */
export function readV5FinalizationInputsFromToken(
  sdkData: string | null | undefined,
): V5FinalizationInputs | null {
  if (!sdkData || typeof sdkData !== 'string') return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(sdkData);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const root = parsed as {
    state?: unknown;
    genesis?: { data?: unknown; inclusionProof?: unknown };
    transactions?: unknown[];
  };

  // Both inclusion proofs MUST be null. Anything else means the
  // transition is past the pending stage and resubmission is unsafe.
  if (root.genesis === undefined || root.genesis === null || typeof root.genesis !== 'object') {
    return null;
  }
  if (root.genesis.inclusionProof !== null) return null;

  const mintDataJson = root.genesis.data as IMintTransactionDataJson | undefined;
  if (!mintDataJson || typeof mintDataJson !== 'object') return null;
  if (typeof mintDataJson.tokenType !== 'string' || !HEX_RE.test(mintDataJson.tokenType)) {
    return null;
  }
  if (typeof mintDataJson.tokenId !== 'string' || !HEX_RE.test(mintDataJson.tokenId)) {
    return null;
  }

  const mintedTokenStateJson = root.state as ITokenStateJson | undefined;
  if (!mintedTokenStateJson || typeof mintedTokenStateJson !== 'object') return null;

  if (!Array.isArray(root.transactions) || root.transactions.length === 0) return null;
  const tx0 = root.transactions[0] as {
    data?: ITransferTransactionDataJson;
    inclusionProof?: unknown;
    _wallet?: { authenticator?: IAuthenticatorJson };
  } | undefined;
  if (!tx0 || typeof tx0 !== 'object') return null;
  if (tx0.inclusionProof !== null) return null;

  const transferTransactionDataJson = tx0.data;
  if (!transferTransactionDataJson || typeof transferTransactionDataJson !== 'object') {
    return null;
  }
  if (
    typeof transferTransactionDataJson.recipient !== 'string'
    || transferTransactionDataJson.recipient.length === 0
    || typeof transferTransactionDataJson.salt !== 'string'
    || !HEX_RE.test(transferTransactionDataJson.salt)
  ) {
    return null;
  }

  const transferAuthenticatorJson = tx0._wallet?.authenticator;
  if (
    !transferAuthenticatorJson
    || typeof transferAuthenticatorJson !== 'object'
    || typeof transferAuthenticatorJson.algorithm !== 'string'
    || typeof transferAuthenticatorJson.signature !== 'string'
    || typeof transferAuthenticatorJson.publicKey !== 'string'
    || typeof transferAuthenticatorJson.stateHash !== 'string'
    || !HEX_RE.test(transferAuthenticatorJson.publicKey)
    || transferAuthenticatorJson.publicKey.length !== SECP256K1_PUBKEY_HEX_LEN
    || !HEX_RE.test(transferAuthenticatorJson.signature)
    || !HEX_RE.test(transferAuthenticatorJson.stateHash)
  ) {
    return null;
  }

  return {
    mintDataJson,
    transferTransactionDataJson,
    transferAuthenticatorJson,
    mintedTokenStateJson,
    tokenTypeHex: mintDataJson.tokenType,
    transferSaltHex: transferTransactionDataJson.salt,
    recipientAddress: transferTransactionDataJson.recipient,
  };
}
