/**
 * Token Split Executor
 * Token split operations for payments
 *
 * Split flow:
 * 1. Burn original token
 * 2. Mint two new tokens: one for recipient, one for sender (change)
 * 3. Create transfer commitment for recipient token
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from '../../core/logger';
import { Token } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId';
import { TokenCoinData } from '@unicitylabs/state-transition-sdk/lib/token/fungible/TokenCoinData';
import { TokenSplitBuilder } from '@unicitylabs/state-transition-sdk/lib/transaction/split/TokenSplitBuilder';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { UnmaskedPredicateReference } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';

// =============================================================================
// Types
// =============================================================================

export interface SplitResult {
  tokenForRecipient: any;
  tokenForSender: any;
  recipientTransferTx: any;
}

export interface TokenSplitExecutorConfig {
  stateTransitionClient: any;
  trustBase: any;
  signingService: any;
}

// =============================================================================
// Hash Utilities
// =============================================================================

async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buffer = new ArrayBuffer(data.length);
  new Uint8Array(buffer).set(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return new Uint8Array(hashBuffer);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// =============================================================================
// Implementation
// =============================================================================

export class TokenSplitExecutor {
  private client: any;
  private trustBase: any;
  private signingService: any;

  constructor(config: TokenSplitExecutorConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.signingService = config.signingService;
  }

  async executeSplit(
    tokenToSplit: any,
    splitAmount: bigint,
    remainderAmount: bigint,
    coinIdHex: string,
    recipientAddress: any
  ): Promise<SplitResult> {
    const tokenIdHex = toHex(tokenToSplit.id.bytes);
    logger.debug('TokenSplit', `Splitting token ${tokenIdHex.slice(0, 8)}...`);

    const coinId = new CoinId(fromHex(coinIdHex));
    const seedString = `${tokenIdHex}_${splitAmount.toString()}_${remainderAmount.toString()}`;

    // Generate IDs and salts
    const recipientTokenId = new TokenId(await sha256(seedString));
    const senderTokenId = new TokenId(await sha256(seedString + '_sender'));
    const recipientSalt = await sha256(seedString + '_recipient_salt');
    const senderSalt = await sha256(seedString + '_sender_salt');

    // Create sender address
    const senderAddressRef = await UnmaskedPredicateReference.create(
      tokenToSplit.type,
      this.signingService.algorithm,
      this.signingService.publicKey,
      HashAlgorithm.SHA256
    );
    const senderAddress = await senderAddressRef.toAddress();

    // Build split
    const builder = new TokenSplitBuilder();

    const coinDataA = TokenCoinData.create([[coinId, splitAmount]]);
    builder.createToken(recipientTokenId, tokenToSplit.type, new Uint8Array(0), coinDataA, senderAddress, recipientSalt, null);

    const coinDataB = TokenCoinData.create([[coinId, remainderAmount]]);
    builder.createToken(senderTokenId, tokenToSplit.type, new Uint8Array(0), coinDataB, senderAddress, senderSalt, null);

    const split = await builder.build(tokenToSplit);

    // Step 1: Burn
    logger.debug('TokenSplit', 'Step 1: Burning original token...');
    const burnSalt = await sha256(seedString + '_burn_salt');
    const burnCommitment = await split.createBurnCommitment(burnSalt, this.signingService);

    const burnResponse = await this.client.submitTransferCommitment(burnCommitment);
    if (burnResponse.status !== 'SUCCESS' && burnResponse.status !== 'REQUEST_ID_EXISTS') {
      throw new Error(`Burn failed: ${burnResponse.status}`);
    }

    const burnInclusionProof = await waitInclusionProof(this.trustBase, this.client, burnCommitment);
    const burnTransaction = burnCommitment.toTransaction(burnInclusionProof);
    logger.debug('TokenSplit', 'Original token burned.');

    // Step 2: Mint
    logger.debug('TokenSplit', 'Step 2: Minting split tokens...');
    const mintCommitments = await split.createSplitMintCommitments(this.trustBase, burnTransaction);

    const mintedTokensInfo: Array<{ commitment: any; inclusionProof: any; isForRecipient: boolean; tokenId: any; salt: Uint8Array }> = [];

    for (const commitment of mintCommitments) {
      const res = await this.client.submitMintCommitment(commitment);
      if (res.status !== 'SUCCESS' && res.status !== 'REQUEST_ID_EXISTS') {
        throw new Error(`Mint split token failed: ${res.status}`);
      }

      const proof = await waitInclusionProof(this.trustBase, this.client, commitment);
      const commTokenIdHex = toHex(commitment.transactionData.tokenId.bytes);
      const recipientIdHex = toHex(recipientTokenId.bytes);

      mintedTokensInfo.push({
        commitment,
        inclusionProof: proof,
        isForRecipient: commTokenIdHex === recipientIdHex,
        tokenId: commitment.transactionData.tokenId,
        salt: commitment.transactionData.salt,
      });
    }
    logger.debug('TokenSplit', 'Split tokens minted.');

    // Step 3: Reconstruct tokens
    const recipientInfo = mintedTokensInfo.find((t) => t.isForRecipient)!;
    const senderInfo = mintedTokensInfo.find((t) => !t.isForRecipient)!;

    const createToken = async (info: typeof recipientInfo, label: string) => {
      const predicate = await UnmaskedPredicate.create(info.tokenId, tokenToSplit.type, this.signingService, HashAlgorithm.SHA256, info.salt);
      const state = new TokenState(predicate, null);
      const token = await Token.mint(this.trustBase, state, info.commitment.toTransaction(info.inclusionProof));
      const verification = await token.verify(this.trustBase);
      if (!verification.isSuccessful) throw new Error(`Token verification failed: ${label}`);
      return token;
    };

    const recipientTokenBeforeTransfer = await createToken(recipientInfo, 'Recipient');
    const senderToken = await createToken(senderInfo, 'Sender');

    // Step 4: Transfer
    logger.debug('TokenSplit', 'Step 3: Transferring to recipient...');
    const transferSalt = await sha256(seedString + '_transfer_salt');

    const transferCommitment = await TransferCommitment.create(
      recipientTokenBeforeTransfer,
      recipientAddress,
      transferSalt,
      null,
      null,
      this.signingService
    );

    const transferRes = await this.client.submitTransferCommitment(transferCommitment);
    if (transferRes.status !== 'SUCCESS' && transferRes.status !== 'REQUEST_ID_EXISTS') {
      throw new Error(`Transfer failed: ${transferRes.status}`);
    }

    const transferProof = await waitInclusionProof(this.trustBase, this.client, transferCommitment);
    const transferTx = transferCommitment.toTransaction(transferProof);

    logger.debug('TokenSplit', 'Split transfer complete!');

    return {
      tokenForRecipient: recipientTokenBeforeTransfer,
      tokenForSender: senderToken,
      recipientTransferTx: transferTx,
    };
  }
}

export function createTokenSplitExecutor(config: TokenSplitExecutorConfig): TokenSplitExecutor {
  return new TokenSplitExecutor(config);
}
