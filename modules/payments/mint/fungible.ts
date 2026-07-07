/**
 * Fungible token mint — free-function form of `mintFungibleToken`.
 *
 * Extracted from PaymentsModule.ts during Phase 5 (uxfv2-refactor-design.md
 * §2.1). Behavior-preserving move: the facade's `mintFungibleToken` delegates
 * here so external call sites (public API on `PaymentsModule`) stay unchanged.
 *
 * Phase 6.C will rewire this onto `ITokenEngine` (per the disposition ledger).
 * For Phase 5, the STSDK v1 call signatures are preserved verbatim.
 */

import type { Token } from '../../../types';
import { hexToBytes as fromHex } from '../../../core/hex';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';

/**
 * Facade-slice consumed by {@link mintFungibleTokenImpl}.
 *
 * The facade (PaymentsModule) passes itself in via {@link MintFungibleTokenDeps}
 * to grant selective access to the small handful of private/public members
 * this operation needs. This keeps the free function behavior-identical to
 * the pre-split class method without exposing PaymentsModule's full internals.
 */
export interface MintFungibleTokenDeps {
  /**
   * State-transition client used to submit the mint commitment.
   * `undefined` when the oracle provider does not expose one.
   */
  readonly stateTransitionClient: StateTransitionClient | undefined;
  /**
   * BFT root trust base for proof verification. `undefined` when the oracle
   * provider does not expose one.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly trustBase: any;
  /**
   * Builds a signing service backed by the wallet's identity private key.
   * Delegates to the facade so the private-key material never leaves it.
   */
  createSigningService(): Promise<SigningService>;
  /** Registry lookup for the coin's UI symbol. */
  getCoinSymbol(coinId: string): string;
  /** Registry lookup for the coin's UI name. */
  getCoinName(coinId: string): string;
  /** Registry lookup for the coin's decimals. */
  getCoinDecimals(coinId: string): number;
  /** Registry lookup for the coin's icon URL (optional). */
  getCoinIconUrl(coinId: string): string | undefined;
  /** Persist the minted Token via the facade's repository layer. */
  addToken(token: Token): Promise<boolean>;
}

/**
 * Mint a fresh fungible token owned by the calling wallet's identity.
 *
 * Behavior:
 * - Generates a random tokenId and salt so each mint is unique.
 * - Uses the same fungible-genesis tokenType prefix as NametagMinter/
 *   InvoiceTokenType so sdkData round-trips against the rest of the wallet.
 * - Recipient is the wallet itself (Unmasked predicate).
 * - Submits the mint commitment with up to 3 retries; treats
 *   `REQUEST_ID_EXISTS` as success (idempotent).
 * - Awaits the inclusion proof, materialises the SDK token, converts it to
 *   the wallet's UI `Token` shape, and persists via `deps.addToken`.
 *
 * Errors are returned as `{ success: false, error }` rather than thrown; the
 * public facade signature preserves this contract for external callers.
 */
export async function mintFungibleTokenImpl(
  deps: MintFungibleTokenDeps,
  coinIdHex: string,
  amount: bigint,
): Promise<{ success: true; token: Token; tokenId: string } | { success: false; error: string }> {
  const stClient = deps.stateTransitionClient;
  if (!stClient) {
    return { success: false, error: 'State transition client not available' };
  }
  const trustBase = deps.trustBase;
  if (!trustBase) {
    return { success: false, error: 'Trust base not available' };
  }

  try {
    const signingService = await deps.createSigningService();
    const { TokenId } = await import('@unicitylabs/state-transition-sdk/lib/token/TokenId');
    const { TokenCoinData } = await import('@unicitylabs/state-transition-sdk/lib/token/fungible/TokenCoinData');
    const { UnmaskedPredicateReference } = await import('@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference');

    // Use the same token-type prefix the wider SDK uses for fungible
    // genesis (see InvoiceTokenType / NametagMinter conventions). This
    // keeps the sdkData shape compatible with the rest of PaymentsModule.
    const tokenTypeBytes = fromHex('f8aa13834268d29355ff12183066f0cb902003629bbc5eb9ef0efbe397867509');
    const tokenType = new TokenType(tokenTypeBytes);

    // Random tokenId — each mint produces a unique token.
    const tokenIdBytes = new Uint8Array(32);
    crypto.getRandomValues(tokenIdBytes);
    const tokenId = new TokenId(tokenIdBytes);

    const coinIdBytes = fromHex(coinIdHex);
    const coinId = new CoinId(coinIdBytes);
    const coinData = TokenCoinData.create([[coinId, amount]]);

    // Recipient = self via UnmaskedPredicateReference → DirectAddress.
    const addressRef = await UnmaskedPredicateReference.create(
      tokenType,
      signingService.algorithm,
      signingService.publicKey,
      HashAlgorithm.SHA256,
    );
    const ownerAddress = await addressRef.toAddress();

    // Random salt — uniqueness gate for the mint commitment.
    const salt = new Uint8Array(32);
    crypto.getRandomValues(salt);

    const mintData = await MintTransactionData.create(
      tokenId,
      tokenType,
      null,            // tokenData: no metadata
      coinData,        // fungible coin data
      ownerAddress,    // recipient = self
      salt,
      null,            // recipientDataHash
      null,            // reason: null (genesis, no burn predecessor)
    );

    const commitment = await MintCommitment.create(mintData);

    // Submit with retry — REQUEST_ID_EXISTS counts as success (idempotent).
    const MAX_RETRIES = 3;
    let lastStatus: string | undefined;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      const response = await stClient.submitMintCommitment(commitment);
      lastStatus = response.status;
      if (response.status === 'SUCCESS' || response.status === 'REQUEST_ID_EXISTS') break;
      if (attempt === MAX_RETRIES) {
        return { success: false, error: `Mint submit failed after ${MAX_RETRIES} attempts: ${response.status}` };
      }
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
    if (lastStatus !== 'SUCCESS' && lastStatus !== 'REQUEST_ID_EXISTS') {
      return { success: false, error: `Mint submit failed: ${lastStatus}` };
    }

    const inclusionProof = await waitInclusionProof(trustBase, stClient, commitment);
    const genesisTransaction = commitment.toTransaction(inclusionProof);

    // Build the token state with an UnmaskedPredicate so this wallet
    // owns the token (predicate verification matches signingService).
    const predicate = await UnmaskedPredicate.create(
      tokenId,
      tokenType,
      signingService,
      HashAlgorithm.SHA256,
      salt,
    );
    const tokenState = new TokenState(predicate, null);
    const sdkToken = await SdkToken.mint(trustBase, tokenState, genesisTransaction);

    // Convert to wallet Token and add it. addToken does the persistence
    // + cache + tombstone bookkeeping.
    const tokenIdHex = tokenId.toJSON();
    const symbol = deps.getCoinSymbol(coinIdHex);
    const name = deps.getCoinName(coinIdHex);
    const decimals = deps.getCoinDecimals(coinIdHex);
    const iconUrl = deps.getCoinIconUrl(coinIdHex);
    const uiToken: Token = {
      id: tokenIdHex,
      coinId: coinIdHex,
      symbol,
      name,
      decimals,
      ...(iconUrl !== undefined ? { iconUrl } : {}),
      amount: amount.toString(),
      status: 'confirmed',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      sdkData: JSON.stringify(sdkToken.toJSON()),
    };
    await deps.addToken(uiToken);

    return { success: true, token: uiToken, tokenId: tokenIdHex };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Local mint failed: ${msg}` };
  }
}
