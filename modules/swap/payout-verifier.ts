/**
 * Per-payout-token verification used by `SwapModule.verifyPayout` (issue #535).
 *
 * Background
 * ----------
 * Until issue #535, `SwapModule.verifyPayout` called the wallet-wide
 * `payments.validate()` and then filtered its `invalid` set down to tokens
 * linked to the payout invoice. That had three problems:
 *
 *   1. **Wrong primitive.** `payments.validate()` is conceptually the
 *      user-facing "audit my whole wallet" diagnostic. Once an inclusion
 *      proof is cryptographically valid against the trustBase, the
 *      aggregator can never revoke it (the SMT is append-only; the BFT
 *      certificate is signed by an immutable validator set for that
 *      epoch). Re-running it across every wallet token is wasted work.
 *   2. **No targeted failure modes.** "not finalized yet" (transient),
 *      "cryptographically invalid" (terminal fraud), and "already spent
 *      out from under us" (terminal fraud, the actual reason this gate
 *      exists) were lumped into one opaque retry loop.
 *   3. **Pre-fix, `validate()` always reported invalid** (PR #534). That
 *      defect masked the design issue for months — the retry loop
 *      naturally hung instead of completing.
 *
 * This module replaces the `validate()`-driven block with three checks
 * scoped to the specific payout tokens:
 *
 *   (a) Finalization — last `transactions[]` entry (or `genesis` for an
 *       unmoved mint) MUST carry an `inclusionProof`. A null proof means
 *       the aggregator hasn't anchored this transition yet → transient.
 *   (b) Cryptographic verify — `SdkToken.verify(trustBase)` runs the full
 *       genesis-→-current chain check locally against the bundled
 *       RootTrustBase. Failure means the escrow signed an invalid mint
 *       (or the token was tampered with) → terminal fraud.
 *   (c) Spent check — `oracle.isSpent(predicatePublicKey, stateHash)`
 *       asks the aggregator whether the predicate guarding the current
 *       state has already produced a transition (i.e. someone spent the
 *       payout out from under us between mint and delivery). True →
 *       terminal fraud.
 *
 * Result discrimination
 * --------------------
 * The function returns a tagged union so the caller can distinguish:
 *
 *   - `{ kind: 'ok' }` — all tokens passed all three checks.
 *   - `{ kind: 'transient', reason }` — caller should `returnFalse()` and
 *     retry on the next verify tick.
 *   - `{ kind: 'terminal', reason }` — caller should `failPayout(reason)`
 *     and transition the swap to `failed`.
 *
 * Throws
 * ------
 * `oracle.isSpent` MUST NOT fail-open per its interface contract. An RPC
 * failure throws — and that throw propagates out of this function to the
 * caller's outer auto-verify catch (which logs and retries). This matches
 * the existing pattern: transient infrastructure problems are retried;
 * cryptographically-verified bad state terminally fails the swap.
 */

import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { extractCurrentStatePublicKeyHexFromSdkData } from '../payments/legacy-v1/extract-state-publickey';
import type { Token } from '../../types';

export type PayoutVerificationResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'transient'; readonly reason: string }
  | { readonly kind: 'terminal'; readonly reason: string };

export interface VerifyPayoutTokensInput {
  /** Token IDs linked to the payout invoice via accounting.getTokenIdsForInvoice. */
  readonly payoutTokenIds: ReadonlySet<string>;
  /** PaymentsModule's getToken — returns the wallet's local Token or undefined. */
  readonly getToken: (id: string) => Token | undefined;
  /** Bundled RootTrustBase from the oracle. SDK-shaped (typed as unknown to keep
   *  this module free of a hard SDK import beyond Token itself). */
  readonly trustBase: unknown | null;
  /** OracleProvider.isSpent — throws on RPC failure (intentional, see file docstring). */
  readonly isSpent: (publicKey: string, stateHash: string) => Promise<boolean>;
  /** Fallback predicate publicKey when extraction from sdkData fails. Typically
   *  the wallet's own chainPubkey — payouts are minted to our predicate so this
   *  is the correct spent-probe target when extraction can't recover the bytes. */
  readonly fallbackPublicKey: string;
}

export async function verifyPayoutTokens(
  input: VerifyPayoutTokensInput,
): Promise<PayoutVerificationResult> {
  const { payoutTokenIds, getToken, trustBase, isSpent, fallbackPublicKey } = input;

  // SECURITY: fail-closed when the reverse index for this invoice is empty.
  // An empty set means accounting's `tokenInvoiceMap` hasn't been rebuilt
  // yet for this invoice (snapshot/restart race) — we cannot determine
  // which tokens to check, so we cannot safely fall through to verified.
  // Transient: the next verify tick picks up after the rebuild completes.
  if (payoutTokenIds.size === 0) {
    return { kind: 'transient', reason: 'payout-reverse-index-empty' };
  }

  if (!trustBase) {
    return { kind: 'transient', reason: 'trustbase-not-loaded' };
  }

  for (const tokenId of payoutTokenIds) {
    const tok = getToken(tokenId);
    if (!tok) {
      return { kind: 'transient', reason: `token-not-in-wallet:${tokenId}` };
    }
    if (!tok.sdkData) {
      return { kind: 'transient', reason: `token-missing-sdkdata:${tokenId}` };
    }

    // (a) Finalization — last transaction (or genesis for an unmoved
    //     mint) must carry an inclusion proof. Parse defensively: a
    //     storage-corrupted sdkData throws here and routes to terminal
    //     (we'd never be able to verify this token, no point retrying).
    let parsedSdkData: unknown;
    try {
      parsedSdkData = JSON.parse(tok.sdkData);
    } catch (err) {
      return {
        kind: 'terminal',
        reason: `PAYOUT_TOKEN_SDKDATA_UNPARSEABLE: ${tokenId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const sdkDataShape = parsedSdkData as {
      transactions?: ReadonlyArray<{ inclusionProof?: unknown }>;
      genesis?: { inclusionProof?: unknown };
    };
    const txs = sdkDataShape.transactions ?? [];
    const lastTx = txs.length > 0 ? txs[txs.length - 1] : sdkDataShape.genesis;
    if (!lastTx || lastTx.inclusionProof == null) {
      return { kind: 'transient', reason: `payout-token-not-finalized:${tokenId}` };
    }

    // (b) Cryptographic verify — SdkToken.fromJSON + verify(trustBase).
    //     A fromJSON throw on well-formed-but-out-of-spec input is
    //     terminal (we can never accept this shape); a verify failure
    //     is also terminal (escrow attested an invalid mint).
    let sdkToken;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sdkToken = await SdkToken.fromJSON(parsedSdkData as any);
    } catch (err) {
      return {
        kind: 'terminal',
        reason: `PAYOUT_TOKEN_PARSE_FAILED: ${tokenId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    let verifyResult: { isSuccessful: boolean };
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      verifyResult = await sdkToken.verify(trustBase as any);
    } catch (err) {
      return {
        kind: 'terminal',
        reason: `PAYOUT_TOKEN_VERIFY_THREW: ${tokenId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    if (!verifyResult.isSuccessful) {
      return {
        kind: 'terminal',
        reason: `PAYOUT_TOKEN_VERIFY_FAILED: ${tokenId}`,
      };
    }

    // (c) Spent check — derive the predicate publicKey, compute the
    //     state hash, ask the aggregator. RPC errors propagate (per
    //     OracleProvider contract — never fail-open).
    const publicKeyHex =
      (await extractCurrentStatePublicKeyHexFromSdkData(tok.sdkData)) ??
      fallbackPublicKey;
    const stateHashHex = (await sdkToken.state.calculateHash()).toJSON();
    const spent = await isSpent(publicKeyHex, stateHashHex);
    if (spent) {
      return {
        kind: 'terminal',
        reason: `PAYOUT_STATE_ALREADY_SPENT: ${tokenId}`,
      };
    }
  }

  return { kind: 'ok' };
}
