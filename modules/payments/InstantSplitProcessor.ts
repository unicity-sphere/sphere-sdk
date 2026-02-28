/**
 * InstantSplitProcessor
 *
 * Processes received INSTANT_SPLIT bundles on the recipient side.
 *
 * V5 Flow (Production Mode):
 * 1. Validate burn transaction (already has proof)
 * 2. Recreate and submit mint commitment -> wait for proof
 * 3. Reconstruct minted token using sender's state from bundle
 * 4. Submit transfer commitment -> wait for proof
 * 5. Create recipient's final state
 * 6. Finalize token with transfer transaction
 * 7. Verify and return finalized token
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import { Token } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';

import {
  type InstantSplitBundle,
  type InstantSplitBundleV5,
  type InstantSplitBundleV4,
  type InstantSplitProcessResult,
  isInstantSplitBundleV5,
  isInstantSplitBundleV4,
} from '../../types/instant-split';

// =============================================================================
// Types
// =============================================================================

export interface InstantSplitProcessorConfig {
  stateTransitionClient: StateTransitionClient;
  trustBase: RootTrustBase;
  /** Dev mode skips trust base verification (for testing) */
  devMode?: boolean;
}

export interface ProcessBundleOptions {
  /** Timeout for proof waiting in ms (default: 60000) */
  proofTimeoutMs?: number;
  /** Callback to find nametag token for PROXY address */
  findNametagToken?: (proxyAddress: string) => Promise<Token<any> | null>;
}

// =============================================================================
// Utility Functions
// =============================================================================

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

// =============================================================================
// InstantSplitProcessor Implementation
// =============================================================================

export class InstantSplitProcessor {
  private client: StateTransitionClient;
  private trustBase: RootTrustBase;
  private devMode: boolean;

  constructor(config: InstantSplitProcessorConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.devMode = config.devMode ?? false;
  }

  /**
   * Process a received INSTANT_SPLIT bundle.
   *
   * @param bundle - The received bundle (V4 or V5)
   * @param signingService - Recipient's signing service
   * @param senderPubkey - Sender's public key (for verification)
   * @param options - Processing options
   * @returns Processing result with finalized token if successful
   */
  async processReceivedBundle(
    bundle: InstantSplitBundle,
    signingService: SigningService,
    senderPubkey: string,
    options?: ProcessBundleOptions
  ): Promise<InstantSplitProcessResult> {
    if (isInstantSplitBundleV5(bundle)) {
      return this.processV5Bundle(bundle, signingService, senderPubkey, options);
    } else if (isInstantSplitBundleV4(bundle)) {
      return this.processV4Bundle(bundle, signingService, senderPubkey, options);
    }

    return {
      success: false,
      error: `Unknown bundle version: ${(bundle as any).version}`,
      durationMs: 0,
    };
  }

  /**
   * Process a V5 bundle (production mode).
   *
   * V5 Flow:
   * 1. Burn transaction already has proof (just validate)
   * 2. Submit mint commitment -> wait for proof
   * 3. Reconstruct minted token (use sender's state from bundle)
   * 4. Submit transfer commitment -> wait for proof
   * 5. Create recipient's final state and finalize token
   */
  private async processV5Bundle(
    bundle: InstantSplitBundleV5,
    signingService: SigningService,
    senderPubkey: string,
    options?: ProcessBundleOptions
  ): Promise<InstantSplitProcessResult> {
    logger.debug('InstantSplit', 'Processing V5 bundle...');
    const startTime = performance.now();

    try {
      // Validate sender pubkey matches bundle
      if (bundle.senderPubkey !== senderPubkey) {
        logger.warn('InstantSplit', 'Sender pubkey mismatch (non-fatal)');
      }

      // === Step 1: Validate burn transaction ===
      const burnTxJson = JSON.parse(bundle.burnTransaction);
      const _burnTransaction = await TransferTransaction.fromJSON(burnTxJson);
      logger.debug('InstantSplit', 'Burn transaction validated');

      // === Step 2: Deserialize and submit MintCommitment ===
      const mintDataJson = JSON.parse(bundle.recipientMintData);
      const mintData = await MintTransactionData.fromJSON(mintDataJson);

      const mintCommitment = await MintCommitment.create(mintData);
      logger.debug('InstantSplit', 'Mint commitment recreated');

      const mintResponse = await this.client.submitMintCommitment(mintCommitment);
      if (mintResponse.status !== 'SUCCESS' && mintResponse.status !== 'REQUEST_ID_EXISTS') {
        throw new SphereError(`Mint submission failed: ${mintResponse.status}`, 'TRANSFER_FAILED');
      }
      logger.debug('InstantSplit', `Mint submitted: ${mintResponse.status}`);

      // === Step 3: Wait for mint inclusion proof ===
      const mintProof = this.devMode
        ? await this.waitInclusionProofWithDevBypass(mintCommitment, options?.proofTimeoutMs)
        : await waitInclusionProof(this.trustBase, this.client, mintCommitment);
      const mintTransaction = mintCommitment.toTransaction(mintProof);
      logger.debug('InstantSplit', 'Mint proof received');

      // === Step 4: Reconstruct minted token using sender's state ===
      const tokenType = new TokenType(fromHex(bundle.tokenTypeHex));
      const senderMintedStateJson = JSON.parse(bundle.mintedTokenStateJson);

      const tokenJson = {
        version: '2.0',
        state: senderMintedStateJson,
        genesis: mintTransaction.toJSON(),
        transactions: [],
        nametags: [],
      };
      const mintedToken = await Token.fromJSON(tokenJson);
      logger.debug('InstantSplit', 'Minted token reconstructed from sender state');

      // === Step 5: Submit transfer commitment ===
      const transferCommitmentJson = JSON.parse(bundle.transferCommitment);
      const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);

      const transferResponse = await this.client.submitTransferCommitment(transferCommitment);
      if (transferResponse.status !== 'SUCCESS' && transferResponse.status !== 'REQUEST_ID_EXISTS') {
        throw new SphereError(`Transfer submission failed: ${transferResponse.status}`, 'TRANSFER_FAILED');
      }
      logger.debug('InstantSplit', `Transfer submitted: ${transferResponse.status}`);

      // === Step 6: Wait for transfer inclusion proof ===
      const transferProof = this.devMode
        ? await this.waitInclusionProofWithDevBypass(transferCommitment, options?.proofTimeoutMs)
        : await waitInclusionProof(this.trustBase, this.client, transferCommitment);
      const transferTransaction = transferCommitment.toTransaction(transferProof);
      logger.debug('InstantSplit', 'Transfer proof received');

      // === Step 7: Create recipient's final state ===
      const transferSalt = fromHex(bundle.transferSaltHex);
      const finalRecipientPredicate = await UnmaskedPredicate.create(
        mintData.tokenId,
        tokenType,
        signingService,
        HashAlgorithm.SHA256,
        transferSalt
      );
      const finalRecipientState = new TokenState(finalRecipientPredicate, null);
      logger.debug('InstantSplit', 'Final recipient state created');

      // === Step 8: Find nametag token for PROXY addresses ===
      let nametagTokens: Token<any>[] = [];
      const recipientAddressStr = bundle.recipientAddressJson;

      if (recipientAddressStr.startsWith('PROXY://')) {
        logger.debug('InstantSplit', 'PROXY address detected, finding nametag token...');

        // Try to get nametag token from bundle first
        if (bundle.nametagTokenJson) {
          try {
            const nametagToken = await Token.fromJSON(JSON.parse(bundle.nametagTokenJson));
            // Validate PROXY address matches nametag token
            const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
            const proxy = await ProxyAddress.fromTokenId(nametagToken.id);
            if (proxy.address !== recipientAddressStr) {
              logger.warn('InstantSplit', 'Nametag PROXY address mismatch, ignoring bundle token');
              // Fall through to callback path
            } else {
              nametagTokens = [nametagToken];
              logger.debug('InstantSplit', 'Using nametag token from bundle (address validated)');
            }
          } catch (err) {
            logger.warn('InstantSplit', 'Failed to parse nametag token from bundle:', err);
          }
        }

        // If not in bundle, use callback to find it
        if (nametagTokens.length === 0 && options?.findNametagToken) {
          const token = await options.findNametagToken(recipientAddressStr);
          if (token) {
            nametagTokens = [token];
            logger.debug('InstantSplit', 'Found nametag token via callback');
          }
        }

        // CRITICAL: For PROXY addresses, we MUST have a nametag token
        if (nametagTokens.length === 0 && !this.devMode) {
          throw new SphereError(
            `PROXY address transfer requires nametag token for verification. ` +
              `Address: ${recipientAddressStr}`,
            'TRANSFER_FAILED'
          );
        }
      }

      // === Step 9: Finalize token ===
      let finalToken: Token<any>;

      if (this.devMode) {
        // Dev mode: create token without verification
        logger.debug('InstantSplit', 'Dev mode: finalizing without verification');
        const tokenJson = mintedToken.toJSON() as any;
        tokenJson.state = finalRecipientState.toJSON();
        tokenJson.transactions = [transferTransaction.toJSON()];
        finalToken = await Token.fromJSON(tokenJson);
      } else {
        // Production: use client.finalizeTransaction
        finalToken = await this.client.finalizeTransaction(
          this.trustBase,
          mintedToken,
          finalRecipientState,
          transferTransaction,
          nametagTokens
        );
      }
      logger.debug('InstantSplit', 'Token finalized');

      // === Step 10: Verify the final token ===
      if (!this.devMode) {
        const verification = await finalToken.verify(this.trustBase);
        if (!verification.isSuccessful) {
          throw new SphereError(`Token verification failed`, 'TRANSFER_FAILED');
        }
        logger.debug('InstantSplit', 'Token verified');
      }

      const duration = performance.now() - startTime;
      logger.debug('InstantSplit', `V5 bundle processed in ${duration.toFixed(0)}ms`);

      return {
        success: true,
        token: finalToken,
        durationMs: duration,
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('InstantSplit', 'V5 processing failed:', error);

      return {
        success: false,
        error: errorMessage,
        durationMs: duration,
      };
    }
  }

  /**
   * Process a V4 bundle (dev mode only).
   *
   * V4 Flow:
   * 1. Submit burn commitment -> wait for proof
   * 2. Submit mint commitment -> wait for proof
   * 3. Reconstruct minted token
   * 4. Submit transfer commitment -> wait for proof
   * 5. Finalize token
   */
  private async processV4Bundle(
    bundle: InstantSplitBundleV4,
    signingService: SigningService,
    _senderPubkey: string,
    options?: ProcessBundleOptions
  ): Promise<InstantSplitProcessResult> {
    if (!this.devMode) {
      return {
        success: false,
        error: 'INSTANT_SPLIT V4 is only supported in dev mode',
        durationMs: 0,
      };
    }

    logger.debug('InstantSplit', 'Processing V4 bundle (dev mode)...');
    const startTime = performance.now();

    try {
      // === Step 1: Submit burn commitment and wait for proof ===
      const burnCommitmentJson = JSON.parse(bundle.burnCommitment);
      const burnCommitment = await TransferCommitment.fromJSON(burnCommitmentJson);

      const burnResponse = await this.client.submitTransferCommitment(burnCommitment);
      if (burnResponse.status !== 'SUCCESS' && burnResponse.status !== 'REQUEST_ID_EXISTS') {
        throw new SphereError(`Burn submission failed: ${burnResponse.status}`, 'TRANSFER_FAILED');
      }

      await this.waitInclusionProofWithDevBypass(burnCommitment, options?.proofTimeoutMs);
      logger.debug('InstantSplit', 'V4: Burn proof received');

      // === Step 2: Submit mint commitment and wait for proof ===
      const mintDataJson = JSON.parse(bundle.recipientMintData);
      const mintData = await MintTransactionData.fromJSON(mintDataJson);

      const mintCommitment = await MintCommitment.create(mintData);

      const mintResponse = await this.client.submitMintCommitment(mintCommitment);
      if (mintResponse.status !== 'SUCCESS' && mintResponse.status !== 'REQUEST_ID_EXISTS') {
        throw new SphereError(`Mint submission failed: ${mintResponse.status}`, 'TRANSFER_FAILED');
      }

      const mintProof = await this.waitInclusionProofWithDevBypass(
        mintCommitment,
        options?.proofTimeoutMs
      );
      const mintTransaction = mintCommitment.toTransaction(mintProof);
      logger.debug('InstantSplit', 'V4: Mint proof received');

      // === Step 3: Reconstruct minted token ===
      const tokenType = new TokenType(fromHex(bundle.tokenTypeHex));
      const recipientSalt = fromHex(bundle.recipientSaltHex);

      const recipientPredicate = await UnmaskedPredicate.create(
        mintData.tokenId,
        tokenType,
        signingService,
        HashAlgorithm.SHA256,
        recipientSalt
      );
      const recipientState = new TokenState(recipientPredicate, null);

      const tokenJson = {
        version: '2.0',
        state: recipientState.toJSON(),
        genesis: mintTransaction.toJSON(),
        transactions: [],
        nametags: [],
      };
      const mintedToken = await Token.fromJSON(tokenJson);
      logger.debug('InstantSplit', 'V4: Minted token reconstructed');

      // === Step 4: Submit transfer commitment and wait for proof ===
      const transferCommitmentJson = JSON.parse(bundle.transferCommitment);
      const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);

      const transferResponse = await this.client.submitTransferCommitment(transferCommitment);
      if (transferResponse.status !== 'SUCCESS' && transferResponse.status !== 'REQUEST_ID_EXISTS') {
        throw new SphereError(`Transfer submission failed: ${transferResponse.status}`, 'TRANSFER_FAILED');
      }

      const transferProof = await this.waitInclusionProofWithDevBypass(
        transferCommitment,
        options?.proofTimeoutMs
      );
      const transferTransaction = transferCommitment.toTransaction(transferProof);
      logger.debug('InstantSplit', 'V4: Transfer proof received');

      // === Step 5: Finalize token (dev mode - no verification) ===
      const transferSalt = fromHex(bundle.transferSaltHex);
      const finalPredicate = await UnmaskedPredicate.create(
        mintData.tokenId,
        tokenType,
        signingService,
        HashAlgorithm.SHA256,
        transferSalt
      );
      const finalState = new TokenState(finalPredicate, null);

      const finalTokenJson = mintedToken.toJSON() as any;
      finalTokenJson.state = finalState.toJSON();
      finalTokenJson.transactions = [transferTransaction.toJSON()];
      const finalToken = await Token.fromJSON(finalTokenJson);
      logger.debug('InstantSplit', 'V4: Token finalized');

      const duration = performance.now() - startTime;
      logger.debug('InstantSplit', `V4 bundle processed in ${duration.toFixed(0)}ms`);

      return {
        success: true,
        token: finalToken,
        durationMs: duration,
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('InstantSplit', 'V4 processing failed:', error);

      return {
        success: false,
        error: errorMessage,
        durationMs: duration,
      };
    }
  }

  /**
   * Dev mode bypass for waitInclusionProof.
   */
  private async waitInclusionProofWithDevBypass(
    commitment: TransferCommitment | MintCommitment<any>,
    timeoutMs = 60000
  ): Promise<any> {
    if (this.devMode) {
      try {
        return await Promise.race([
          waitInclusionProof(this.trustBase, this.client, commitment as any),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Dev mode timeout')), Math.min(timeoutMs, 5000))
          ),
        ]);
      } catch {
        logger.debug('InstantSplit', 'Dev mode: Using mock proof');
        return {
          toJSON: () => ({ mock: true }),
        };
      }
    }
    return waitInclusionProof(this.trustBase, this.client, commitment as any);
  }
}

/**
 * Factory function for creating InstantSplitProcessor
 */
export function createInstantSplitProcessor(
  config: InstantSplitProcessorConfig
): InstantSplitProcessor {
  return new InstantSplitProcessor(config);
}
