/**
 * Per-payout-token verification used by `SwapModule.verifyPayout` (issue #535)
 * — Phase 6.P2.3 rewrite atop `ITokenEngine`.
 *
 * Background
 * ----------
 * Before Phase 6, this file talked to the v1 state-transition-sdk directly:
 * parse the sdkData JSON, run `SdkToken.fromJSON`, call
 * `SdkToken.verify(trustBase)`, then ask an `OracleProvider.isSpent(publicKey,
 * stateHash)` scoped to the extracted predicate state. The three-way outcome
 * — `ok` / `transient` / `terminal` — was carefully shaped so
 * `SwapModule.verifyPayout` could distinguish "not finalized yet",
 * "cryptographically invalid", and "already spent out from under us"
 * (issue #535 background is preserved verbatim below).
 *
 * The v2 anti-corruption engine collapses the whole check into three engine
 * calls:
 *
 *   (a) Finalization / cryptographic verify — {@link ITokenEngine.verify}
 *       delivers the full genesis→current chain check against the bundled
 *       RootTrustBase. `ok === false` maps to `terminal` (a payout the escrow
 *       attested as invalid is fraud, not a retry).
 *   (b) Spent check — {@link ITokenEngine.isSpent} answers whether the
 *       token's CURRENT state has already been consumed. `true` maps to
 *       `terminal` — the payout was spent out from under us.
 *   (c) Ownership check — {@link ITokenEngine.isOwnedBy}, evaluated against
 *       the wallet's chainPubkey, answers "is this token even addressed to
 *       us". Ownership failure maps to `terminal` (fraud / misroute).
 *
 * Behavior contract preserved
 * ---------------------------
 * `verifyPayoutTokens` returns exactly the same tagged union so the caller
 * (`SwapModule.verifyPayout`) does not change discrimination logic:
 *
 *   - `{ kind: 'ok' }` — all tokens passed all three checks.
 *   - `{ kind: 'transient', reason }` — caller should return false and retry.
 *   - `{ kind: 'terminal', reason }` — caller should fail the payout.
 *
 * A `null` / `undefined` tokenEngine (Phase 6.P2.3 landed the type; wire-up
 * lands in Phase 6.P2.4) returns `transient` so the retry loop stays intact
 * until the engine is wired. RPC errors from `isSpent` propagate — matches
 * the v1 fail-closed rule (see issue #535 header notes in git history).
 */

import type { ITokenEngine, SphereToken } from '../../token-engine';

export type PayoutVerificationResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'transient'; readonly reason: string }
  | { readonly kind: 'terminal'; readonly reason: string };

export interface VerifyPayoutTokensInput {
  /** Token IDs linked to the payout invoice via accounting.getTokenIdsForInvoice. */
  readonly payoutTokenIds: ReadonlySet<string>;
  /**
   * Caller-provided lookup returning the wallet's local {@link SphereToken}
   * for `id`, or `undefined` when the token has not landed yet. Consumers
   * that still hold v1 UI `Token`s can wrap their store with a converter
   * (Phase 6.P2.4 wires the converter through PaymentsModule).
   */
  readonly getSphereToken: (id: string) => SphereToken | undefined;
  /** Anti-corruption engine port. `null`/`undefined` yields a transient result. */
  readonly tokenEngine: ITokenEngine | null | undefined;
  /**
   * Wallet's 33-byte compressed chain pubkey. Used for the ownership probe —
   * payouts are minted to OUR predicate.
   */
  readonly expectedOwnerPubkey: Uint8Array;
}

export async function verifyPayoutTokens(
  input: VerifyPayoutTokensInput,
): Promise<PayoutVerificationResult> {
  const { payoutTokenIds, getSphereToken, tokenEngine, expectedOwnerPubkey } = input;

  // SECURITY: fail-closed when the reverse index for this invoice is empty.
  // An empty set means accounting's `tokenInvoiceMap` hasn't been rebuilt
  // yet for this invoice (snapshot/restart race). Transient — the next
  // verify tick picks up after the rebuild completes.
  if (payoutTokenIds.size === 0) {
    return { kind: 'transient', reason: 'payout-reverse-index-empty' };
  }

  if (!tokenEngine) {
    return { kind: 'transient', reason: 'token-engine-not-wired' };
  }

  for (const tokenId of payoutTokenIds) {
    const sphereToken = getSphereToken(tokenId);
    if (!sphereToken) {
      return { kind: 'transient', reason: `token-not-in-wallet:${tokenId}` };
    }

    // (a) Finalization / cryptographic verify.
    let verifyResult: { ok: boolean; reason?: string };
    try {
      verifyResult = await tokenEngine.verify(sphereToken);
    } catch (err) {
      return {
        kind: 'terminal',
        reason: `PAYOUT_TOKEN_VERIFY_THREW: ${tokenId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (!verifyResult.ok) {
      return {
        kind: 'terminal',
        reason: `PAYOUT_TOKEN_VERIFY_FAILED: ${tokenId}: ${verifyResult.reason ?? 'unspecified'}`,
      };
    }

    // (c) Ownership probe — synchronous predicate byte-compare (no network).
    if (!tokenEngine.isOwnedBy(sphereToken, expectedOwnerPubkey)) {
      return {
        kind: 'terminal',
        reason: `PAYOUT_TOKEN_NOT_OWNED: ${tokenId}`,
      };
    }

    // (b) Spent check — engine calls the aggregator. RPC errors propagate
    // (fail-closed contract).
    const spent = await tokenEngine.isSpent(sphereToken);
    if (spent) {
      return {
        kind: 'terminal',
        reason: `PAYOUT_STATE_ALREADY_SPENT: ${tokenId}`,
      };
    }
  }

  return { kind: 'ok' };
}
