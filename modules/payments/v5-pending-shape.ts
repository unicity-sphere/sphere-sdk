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
import type { IAuthenticatorJson } from '@unicitylabs/state-transition-sdk/lib/api/Authenticator';
import type { IMintTransactionDataJson } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import type { ITransferTransactionDataJson } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData';
import type { ITokenStateJson } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import type { InstantSplitBundleV5, PendingV5Finalization } from '../../types/instant-split';

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
 * Construct the UXF/TXF-valid sdkData for a V5-pending token from a V5
 * bundle. Returns the JSON string, or `null` if the bundle is malformed
 * (caller logs + falls back to the legacy opaque shape).
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
): string | null {
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
      return null;
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

    return JSON.stringify(syntheticTxf);
  } catch {
    return null;
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

/**
 * Read V5 finalization inputs from the synthetic token shape.
 *
 * Returns `null` if:
 *   - sdkData is not parseable as JSON
 *   - genesis / state / transactions[0] are absent or malformed
 *   - transactions[0]._wallet.authenticator is missing (no sender-signed
 *     authenticator means we can't re-submit the transfer commitment)
 *
 * Callers fall back to parsing `pending.bundleJson` on null.
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

  const mintDataJson = root.genesis?.data as IMintTransactionDataJson | undefined;
  if (!mintDataJson || typeof mintDataJson !== 'object') return null;
  if (typeof mintDataJson.tokenType !== 'string') return null;

  const mintedTokenStateJson = root.state as ITokenStateJson | undefined;
  if (!mintedTokenStateJson || typeof mintedTokenStateJson !== 'object') return null;

  if (!Array.isArray(root.transactions) || root.transactions.length === 0) return null;
  const tx0 = root.transactions[0] as {
    data?: ITransferTransactionDataJson;
    _wallet?: { authenticator?: IAuthenticatorJson };
  } | undefined;
  if (!tx0 || typeof tx0 !== 'object') return null;

  const transferTransactionDataJson = tx0.data;
  if (!transferTransactionDataJson || typeof transferTransactionDataJson !== 'object') {
    return null;
  }
  if (
    typeof transferTransactionDataJson.recipient !== 'string'
    || typeof transferTransactionDataJson.salt !== 'string'
  ) {
    return null;
  }

  const transferAuthenticatorJson = tx0._wallet?.authenticator;
  if (
    !transferAuthenticatorJson
    || typeof transferAuthenticatorJson !== 'object'
    || typeof transferAuthenticatorJson.publicKey !== 'string'
    || typeof transferAuthenticatorJson.stateHash !== 'string'
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
