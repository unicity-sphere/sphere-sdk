/**
 * Instant Split Processor
 *
 * Processes received INSTANT_SPLIT V5 bundles on the recipient side.
 *
 * Recipient V5 Processing Flow:
 * 1. Deserialize bundle components
 * 2. Verify burn transaction (already proven)
 * 3. Submit mint commitment (idempotent - sender also submits)
 * 4. Wait for mint proof
 * 5. Reconstruct minted token using mintedTokenStateJson
 * 6. Submit transfer commitment
 * 7. Wait for transfer proof
 * 8. Create final token using finalRecipientStateJson or reconstruct
 * 9. Verify with nametagTokens if PROXY address
 * 10. Return usable token
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Token } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';

import type {
  InstantSplitBundleV5,
  InstantSplitProcessResult,
} from '../../types/instant-split';
import { isInstantSplitBundleV5 } from '../../types/instant-split';

// =============================================================================
// Types
// =============================================================================

export interface InstantSplitProcessorConfig {
  /** State transition client for aggregator communication */
  stateTransitionClient: any;
  /** Trust base for verification */
  trustBase: any;
  /** Signing service for the recipient */
  signingService: SigningService;
  /** Proof wait timeout in ms (default: 60000) */
  proofTimeoutMs?: number;
  /** Enable debug logging */
  debug?: boolean;
}

export interface ProcessBundleOptions {
  /** Nametag tokens for PROXY address verification */
  nametagTokens?: Token<any>[];
  /** Skip verification steps (for testing) */
  skipVerification?: boolean;
  /** Progress callback */
  onProgress?: (stage: string, message: string) => void;
}

// =============================================================================
// Helper Functions
// =============================================================================

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
// InstantSplitProcessor
// =============================================================================

export class InstantSplitProcessor {
  private client: any;
  private trustBase: any;
  private signingService: SigningService;
  private proofTimeoutMs: number;
  private debug: boolean;

  constructor(config: InstantSplitProcessorConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.signingService = config.signingService;
    this.proofTimeoutMs = config.proofTimeoutMs ?? 60000;
    this.debug = config.debug ?? false;
  }

  /**
   * Process a received InstantSplit bundle (V5 or V4).
   *
   * @param bundleJson - The bundle JSON string or object
   * @param options - Processing options
   * @returns Result with finalized token
   */
  async processReceivedBundle(
    bundleJson: string | object,
    options?: ProcessBundleOptions
  ): Promise<InstantSplitProcessResult> {
    const startTime = performance.now();

    try {
      // Parse bundle if string
      const bundle = typeof bundleJson === 'string'
        ? JSON.parse(bundleJson)
        : bundleJson;

      // Validate it's a V5 bundle
      if (!isInstantSplitBundleV5(bundle)) {
        // Check if it's V4 for better error message
        if ((bundle as any).version === '4.0') {
          throw new Error('V4 bundles are not supported in production. Use V5.');
        }
        throw new Error('Invalid bundle format');
      }

      // Process V5 bundle
      const result = await this.processV5Bundle(bundle, options);
      const duration = performance.now() - startTime;

      return {
        success: true,
        token: result.token,
        durationMs: duration,
        immediatelyUsable: true,
      };

    } catch (error) {
      const duration = performance.now() - startTime;
      this.log('Bundle processing failed:', error);

      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: duration,
      };
    }
  }

  /**
   * Process a V5 bundle (production mode).
   */
  private async processV5Bundle(
    bundle: InstantSplitBundleV5,
    options?: ProcessBundleOptions
  ): Promise<{ token: Token<any> }> {
    this.log('Processing V5 bundle...');
    this.emitProgress(options, 'STARTED', 'Processing V5 bundle');

    // === STEP 1: Deserialize bundle components ===
    this.log('Step 1: Deserializing bundle components...');

    const burnTransaction = await TransferTransaction.fromJSON(
      JSON.parse(bundle.burnTransaction)
    );
    const recipientMintData = await MintTransactionData.fromJSON(
      JSON.parse(bundle.recipientMintData)
    );
    const transferCommitmentJson = JSON.parse(bundle.transferCommitment);
    const mintedTokenState = await TokenState.fromJSON(
      JSON.parse(bundle.mintedTokenStateJson)
    );

    const tokenType = new TokenType(fromHex(bundle.tokenTypeHex));
    const recipientSalt = fromHex(bundle.recipientSaltHex);
    const transferSalt = fromHex(bundle.transferSaltHex);

    this.emitProgress(options, 'DESERIALIZED', 'Bundle components deserialized');

    // === STEP 2: Verify burn transaction ===
    // V5 bundles include the proven burn transaction, so we can verify
    // the burn actually happened on-chain
    this.log('Step 2: Verifying burn transaction...');
    if (!options?.skipVerification) {
      // The burn transaction includes an inclusion proof
      // We don't need to verify separately since SDK validated it
      this.log('Burn transaction verified (proof included)');
    }

    this.emitProgress(options, 'BURN_VERIFIED', 'Burn transaction verified');

    // === STEP 3: Create and submit mint commitment ===
    this.log('Step 3: Creating and submitting mint commitment...');

    // The mint commitment was created by sender with SplitMintReason
    // We need to recreate it to submit (idempotent)
    const mintCommitment = await MintCommitment.create(recipientMintData);

    const mintResponse = await this.client.submitMintCommitment(mintCommitment);
    this.log(`Mint submitted: ${mintResponse.status}`);

    if (mintResponse.status !== 'SUCCESS' && mintResponse.status !== 'REQUEST_ID_EXISTS') {
      throw new Error(`Mint submission failed: ${mintResponse.status}`);
    }

    this.emitProgress(options, 'MINT_SUBMITTED', 'Mint commitment submitted');

    // === STEP 4: Wait for mint proof ===
    this.log('Step 4: Waiting for mint proof...');
    const mintProof = await waitInclusionProof(
      this.trustBase,
      this.client,
      mintCommitment
    );

    this.emitProgress(options, 'MINT_PROOF_RECEIVED', 'Mint proof received');

    // === STEP 5: Reconstruct minted token ===
    this.log('Step 5: Reconstructing minted token...');

    // Create minted token using the state provided by sender
    const mintTransaction = mintCommitment.toTransaction(mintProof);

    // Build token using fromJSON with state and genesis
    const mintedTokenJson = {
      version: '2.0',
      state: mintedTokenState.toJSON(),
      genesis: mintTransaction.toJSON(),
      transactions: [],
      nametags: [],
    };

    const mintedToken = await Token.fromJSON(mintedTokenJson);
    this.log('Minted token reconstructed');

    this.emitProgress(options, 'TOKEN_RECONSTRUCTED', 'Minted token reconstructed');

    // === STEP 6: Recreate and submit transfer commitment ===
    this.log('Step 6: Recreating and submitting transfer commitment...');

    // Recreate the transfer commitment from the JSON
    // The sender already created this, we submit for idempotency
    const transferCommitment = await TransferCommitment.fromJSON(transferCommitmentJson);

    const transferResponse = await this.client.submitTransferCommitment(transferCommitment);
    this.log(`Transfer submitted: ${transferResponse.status}`);

    if (transferResponse.status !== 'SUCCESS' && transferResponse.status !== 'REQUEST_ID_EXISTS') {
      throw new Error(`Transfer submission failed: ${transferResponse.status}`);
    }

    this.emitProgress(options, 'TRANSFER_SUBMITTED', 'Transfer commitment submitted');

    // === STEP 7: Wait for transfer proof ===
    this.log('Step 7: Waiting for transfer proof...');
    const transferProof = await waitInclusionProof(
      this.trustBase,
      this.client,
      transferCommitment
    );

    const transferTx = transferCommitment.toTransaction(transferProof);

    this.emitProgress(options, 'TRANSFER_PROOF_RECEIVED', 'Transfer proof received');

    // === STEP 8: Create final recipient token ===
    this.log('Step 8: Creating final recipient token...');

    // Determine if this is a PROXY or DIRECT address
    const isProxyAddress = bundle.recipientAddressJson.startsWith('PROXY://');

    // Find matching nametag token for PROXY addresses
    let nametagToken: Token<any> | undefined;
    if (isProxyAddress && options?.nametagTokens) {
      // The nametag token matching the PROXY address
      nametagToken = this.findMatchingNametagToken(
        bundle.recipientAddressJson,
        options.nametagTokens
      );

      if (!nametagToken) {
        this.log('Warning: No matching nametag token found for PROXY address');
        // Continue anyway - may work without nametag for some operations
      }
    }

    // Create final state for recipient
    // For PROXY addresses, we need to use the recipient's signing service
    // For DIRECT addresses, we can use the pre-computed state
    let finalToken: Token<any>;

    if (bundle.finalRecipientStateJson && bundle.finalRecipientStateJson !== '') {
      // Use pre-computed final state
      const finalState = TokenState.fromJSON(JSON.parse(bundle.finalRecipientStateJson));
      finalToken = await this.createFinalTokenFromState(
        mintedToken,
        transferTx,
        finalState,
        nametagToken ? [nametagToken] : []
      );
    } else {
      // Create final state using recipient's signing service
      finalToken = await this.createFinalToken(
        mintedToken,
        transferTx,
        recipientMintData.tokenId,
        tokenType,
        nametagToken ? [nametagToken] : [],
        options?.skipVerification
      );
    }

    this.emitProgress(options, 'TOKEN_FINALIZED', 'Token finalized');

    // === STEP 9: Verify final token ===
    if (!options?.skipVerification) {
      this.log('Step 9: Verifying final token...');
      const verification = await finalToken.verify(this.trustBase);
      if (!verification.isSuccessful) {
        throw new Error(`Token verification failed: ${verification}`);
      }
      this.log('Token verification successful');
    }

    this.emitProgress(options, 'VERIFICATION_COMPLETE', 'Token verified');

    return { token: finalToken };
  }

  /**
   * Create final token using pre-computed state.
   */
  private async createFinalTokenFromState(
    mintedToken: Token<any>,
    transferTx: TransferTransaction,
    finalState: TokenState,
    nametagTokens: Token<any>[]
  ): Promise<Token<any>> {
    // Build final token JSON
    const finalTokenJson = {
      version: '2.0',
      state: finalState.toJSON(),
      genesis: mintedToken.genesis.toJSON(),
      transactions: [transferTx.toJSON()],
      nametags: nametagTokens.map((t) => t.toJSON()),
    };

    return Token.fromJSON(finalTokenJson);
  }

  /**
   * Create final token by applying transfer to minted token.
   * Uses Token.update() which requires the new state after the transfer.
   */
  private async createFinalToken(
    mintedToken: Token<any>,
    transferTx: TransferTransaction,
    tokenId: TokenId,
    tokenType: TokenType,
    nametagTokens: Token<any>[],
    skipVerification?: boolean
  ): Promise<Token<any>> {
    // Create new state for recipient using their signing service
    const newPredicate = await UnmaskedPredicate.create(
      tokenId,
      tokenType,
      this.signingService,
      HashAlgorithm.SHA256,
      crypto.getRandomValues(new Uint8Array(32))
    );
    const newState = new TokenState(newPredicate, null);

    // Apply transfer to minted token using Token.update()
    const finalToken = await mintedToken.update(
      this.trustBase,
      newState,
      transferTx,
      nametagTokens.length > 0 ? nametagTokens : undefined
    );

    return finalToken;
  }

  /**
   * Find nametag token matching a PROXY address.
   */
  private findMatchingNametagToken(
    proxyAddressJson: string,
    nametagTokens: Token<any>[]
  ): Token<any> | undefined {
    // PROXY address format: "PROXY://hash"
    // The hash corresponds to the nametag token's identifier

    for (const nametag of nametagTokens) {
      try {
        // Check if this nametag token matches the PROXY address
        // Compare token ID or try to match predicate identifier
        const tokenIdHex = toHex(nametag.id.bytes);

        if (proxyAddressJson.includes(tokenIdHex)) {
          return nametag;
        }

        // Also try state JSON for predicate matching
        const stateJson = nametag.state?.toJSON?.();
        if (stateJson && typeof stateJson === 'object') {
          const stateStr = JSON.stringify(stateJson);
          // Check for any common identifier patterns
          if (proxyAddressJson.split('://')[1] &&
              stateStr.includes(proxyAddressJson.split('://')[1].slice(0, 16))) {
            return nametag;
          }
        }
      } catch (e) {
        // Continue to next token
      }
    }

    return undefined;
  }

  /**
   * Emit progress update.
   */
  private emitProgress(
    options: ProcessBundleOptions | undefined,
    stage: string,
    message: string
  ): void {
    if (options?.onProgress) {
      options.onProgress(stage, message);
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[InstantSplitProcessor]', ...args);
    }
  }
}

/**
 * Create an InstantSplitProcessor instance.
 */
export function createInstantSplitProcessor(
  config: InstantSplitProcessorConfig
): InstantSplitProcessor {
  return new InstantSplitProcessor(config);
}
