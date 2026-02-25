/**
 * InstantSplitExecutor
 *
 * Optimized token split executor that achieves ~2.3s critical path latency
 * instead of the standard ~42s sequential flow.
 *
 * Key Insight: TransferCommitment.create() only needs token.state, NOT the mint proof.
 * This allows creating transfer commitments immediately after mint data creation,
 * without waiting for mint proofs.
 *
 * V5 Flow (Production Mode):
 * 1. Create burn commitment, submit to aggregator (~50ms)
 * 2. Wait for burn inclusion proof (~2s - unavoidable)
 * 3. Create mint commitments with proper SplitMintReason (~50ms)
 * 4. Create transfer commitment from mint data (~100ms)
 * 5. Package bundle -> send via transport -> SUCCESS (~150ms)
 * TOTAL: ~2.3s
 *
 * Background (non-blocking):
 * 6. Submit mint commitments (parallel)
 * 7. Wait for mint proofs
 * 8. Reconstruct & save change token
 * 9. Sync to storage
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Token } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId';
import { TokenCoinData } from '@unicitylabs/state-transition-sdk/lib/token/fungible/TokenCoinData';
import { TokenSplitBuilder } from '@unicitylabs/state-transition-sdk/lib/transaction/split/TokenSplitBuilder';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { UnmaskedPredicateReference } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicateReference';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import type { IAddress } from '@unicitylabs/state-transition-sdk/lib/address/IAddress';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';

import type {
  InstantSplitBundleV5,
  InstantSplitResult,
  InstantSplitOptions,
  BackgroundProgressStatus,
  BuildSplitBundleResult,
} from '../../types/instant-split';
import type { TransportProvider } from '../../transport';

// =============================================================================
// Types
// =============================================================================

export interface InstantSplitExecutorConfig {
  stateTransitionClient: StateTransitionClient;
  trustBase: RootTrustBase;
  signingService: SigningService;
  /** Dev mode skips trust base verification (for testing) */
  devMode?: boolean;
}

export interface InstantSplitExecutorDeps {
  stClient: StateTransitionClient;
  trustBase: RootTrustBase;
  signingService: SigningService;
  devMode?: boolean;
}

export interface BackgroundContext {
  signingService: SigningService;
  tokenType: TokenType;
  coinId: CoinId;
  senderTokenId: TokenId;
  senderSalt: Uint8Array;
  onProgress?: (status: BackgroundProgressStatus) => void;
  onChangeTokenCreated?: (token: Token<any>) => Promise<void>;
  onStorageSync?: () => Promise<boolean>;
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
// InstantSplitExecutor Implementation
// =============================================================================

export class InstantSplitExecutor {
  private client: StateTransitionClient;
  private trustBase: RootTrustBase;
  private signingService: SigningService;
  private devMode: boolean;

  constructor(config: InstantSplitExecutorConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.signingService = config.signingService;
    this.devMode = config.devMode ?? false;
  }

  /**
   * Build a V5 split bundle WITHOUT sending it via transport.
   *
   * Steps 1-5 of the V5 flow:
   * 1. Create and submit burn commitment
   * 2. Wait for burn proof
   * 3. Create mint commitments with SplitMintReason
   * 4. Create transfer commitment (no mint proof needed)
   * 5. Package V5 bundle
   *
   * The caller is responsible for sending the bundle and then calling
   * `startBackground()` on the result to begin mint proof + change token creation.
   */
  async buildSplitBundle(
    tokenToSplit: Token<any>,
    splitAmount: bigint,
    remainderAmount: bigint,
    coinIdHex: string,
    recipientAddress: IAddress,
    options?: InstantSplitOptions
  ): Promise<BuildSplitBundleResult> {
    const splitGroupId = crypto.randomUUID();
    const tokenIdHex = toHex(tokenToSplit.id.bytes);
    console.log(`[InstantSplit] Building V5 bundle for token ${tokenIdHex.slice(0, 8)}...`);

    const coinId = new CoinId(fromHex(coinIdHex));
    const seedString = `${tokenIdHex}_${splitAmount.toString()}_${remainderAmount.toString()}_${Date.now()}`;

    // Generate IDs and salts (deterministic from seed)
    const recipientTokenId = new TokenId(await sha256(seedString));
    const senderTokenId = new TokenId(await sha256(seedString + '_sender'));
    const recipientSalt = await sha256(seedString + '_recipient_salt');
    const senderSalt = await sha256(seedString + '_sender_salt');

    // Create sender address (for minting to self first)
    const senderAddressRef = await UnmaskedPredicateReference.create(
      tokenToSplit.type,
      this.signingService.algorithm,
      this.signingService.publicKey,
      HashAlgorithm.SHA256
    );
    const senderAddress = await senderAddressRef.toAddress();

    // Build split configuration
    const builder = new TokenSplitBuilder();

    // Recipient token (will be transferred)
    const coinDataA = TokenCoinData.create([[coinId, splitAmount]]);
    builder.createToken(
      recipientTokenId,
      tokenToSplit.type,
      new Uint8Array(0),
      coinDataA,
      senderAddress, // Mint to sender first, then transfer
      recipientSalt,
      null
    );

    // Sender token (change)
    const coinDataB = TokenCoinData.create([[coinId, remainderAmount]]);
    builder.createToken(
      senderTokenId,
      tokenToSplit.type,
      new Uint8Array(0),
      coinDataB,
      senderAddress,
      senderSalt,
      null
    );

    const split = await builder.build(tokenToSplit);

    // === STEP 1: CREATE AND SUBMIT BURN COMMITMENT ===
    console.log('[InstantSplit] Step 1: Creating and submitting burn...');
    const burnSalt = await sha256(seedString + '_burn_salt');
    const burnCommitment = await split.createBurnCommitment(burnSalt, this.signingService);

    const burnResponse = await this.client.submitTransferCommitment(burnCommitment);
    if (burnResponse.status !== 'SUCCESS' && burnResponse.status !== 'REQUEST_ID_EXISTS') {
      throw new Error(`Burn submission failed: ${burnResponse.status}`);
    }

    // === STEP 2: WAIT FOR BURN PROOF (~2s) ===
    console.log('[InstantSplit] Step 2: Waiting for burn proof...');
    const burnProof = this.devMode
      ? await this.waitInclusionProofWithDevBypass(burnCommitment, options?.burnProofTimeoutMs)
      : await waitInclusionProof(this.trustBase, this.client, burnCommitment);
    const burnTransaction = burnCommitment.toTransaction(burnProof);

    console.log(`[InstantSplit] Burn proof received`);

    options?.onBurnCompleted?.(JSON.stringify(burnTransaction.toJSON()));

    // === STEP 3: CREATE MINT COMMITMENTS WITH SPLITMINT REASON ===
    console.log('[InstantSplit] Step 3: Creating mint commitments...');
    const mintCommitments = await split.createSplitMintCommitments(this.trustBase, burnTransaction);

    // Find recipient and sender mint commitments
    const recipientIdHex = toHex(recipientTokenId.bytes);
    const senderIdHex = toHex(senderTokenId.bytes);

    const recipientMintCommitment = mintCommitments.find(
      (c) => toHex(c.transactionData.tokenId.bytes) === recipientIdHex
    );
    const senderMintCommitment = mintCommitments.find(
      (c) => toHex(c.transactionData.tokenId.bytes) === senderIdHex
    );

    if (!recipientMintCommitment || !senderMintCommitment) {
      throw new Error('Failed to find expected mint commitments');
    }

    // === STEP 4: CREATE TRANSFER COMMITMENT FROM MINT DATA ===
    console.log('[InstantSplit] Step 4: Creating transfer commitment...');
    const transferSalt = await sha256(seedString + '_transfer_salt');

    const transferCommitment = await this.createTransferCommitmentFromMintData(
      recipientMintCommitment.transactionData,
      recipientAddress,
      transferSalt,
      this.signingService
    );

    // Create minted token state for recipient to reconstruct
    const mintedPredicate = await UnmaskedPredicate.create(
      recipientTokenId,
      tokenToSplit.type,
      this.signingService,
      HashAlgorithm.SHA256,
      recipientSalt
    );
    const mintedState = new TokenState(mintedPredicate, null);

    // === STEP 5: PACKAGE V5 BUNDLE ===
    console.log('[InstantSplit] Step 5: Packaging V5 bundle...');
    const senderPubkey = toHex(this.signingService.publicKey);

    // Get nametag token if this is a PROXY address transfer
    let nametagTokenJson: string | undefined;
    const recipientAddressStr = recipientAddress.toString();
    if (recipientAddressStr.startsWith('PROXY://') && tokenToSplit.nametagTokens?.length > 0) {
      // Include sender's nametag token for PROXY verification
      nametagTokenJson = JSON.stringify(tokenToSplit.nametagTokens[0].toJSON());
    }

    const bundle: InstantSplitBundleV5 = {
      version: '5.0',
      type: 'INSTANT_SPLIT',
      burnTransaction: JSON.stringify(burnTransaction.toJSON()),
      recipientMintData: JSON.stringify(recipientMintCommitment.transactionData.toJSON()),
      transferCommitment: JSON.stringify(transferCommitment.toJSON()),
      amount: splitAmount.toString(),
      coinId: coinIdHex,
      tokenTypeHex: toHex(tokenToSplit.type.bytes),
      splitGroupId,
      senderPubkey,
      recipientSaltHex: toHex(recipientSalt),
      transferSaltHex: toHex(transferSalt),
      mintedTokenStateJson: JSON.stringify(mintedState.toJSON()),
      finalRecipientStateJson: '', // Recipient creates their own
      recipientAddressJson: recipientAddressStr,
      nametagTokenJson,
    };

    return {
      bundle,
      splitGroupId,
      startBackground: async () => {
        if (!options?.skipBackground) {
          await this.submitBackgroundV5(senderMintCommitment, recipientMintCommitment, transferCommitment, {
            signingService: this.signingService,
            tokenType: tokenToSplit.type,
            coinId,
            senderTokenId,
            senderSalt,
            onProgress: options?.onBackgroundProgress,
            onChangeTokenCreated: options?.onChangeTokenCreated,
            onStorageSync: options?.onStorageSync,
          });
        }
      },
    };
  }

  /**
   * Execute an instant split transfer with V5 optimized flow.
   *
   * Builds the bundle via buildSplitBundle(), sends via transport,
   * and starts background processing.
   *
   * @param tokenToSplit - The SDK token to split
   * @param splitAmount - Amount to send to recipient
   * @param remainderAmount - Amount to keep as change
   * @param coinIdHex - Coin ID in hex format
   * @param recipientAddress - Recipient's address (PROXY or DIRECT)
   * @param transport - Transport provider for sending the bundle
   * @param recipientPubkey - Recipient's transport public key
   * @param options - Optional configuration
   * @returns InstantSplitResult with success status and timing info
   */
  async executeSplitInstant(
    tokenToSplit: Token<any>,
    splitAmount: bigint,
    remainderAmount: bigint,
    coinIdHex: string,
    recipientAddress: IAddress,
    transport: TransportProvider,
    recipientPubkey: string,
    options?: InstantSplitOptions
  ): Promise<InstantSplitResult> {
    const startTime = performance.now();

    try {
      const buildResult = await this.buildSplitBundle(
        tokenToSplit,
        splitAmount,
        remainderAmount,
        coinIdHex,
        recipientAddress,
        options
      );

      // === SEND VIA TRANSPORT ===
      console.log('[InstantSplit] Sending via transport...');
      const senderPubkey = toHex(this.signingService.publicKey);
      const nostrEventId = await transport.sendTokenTransfer(recipientPubkey, {
        token: JSON.stringify(buildResult.bundle),
        proof: null, // Proof is included in the bundle
        memo: options?.memo,
        sender: {
          transportPubkey: senderPubkey,
        },
      });

      const criticalPathDuration = performance.now() - startTime;
      console.log(`[InstantSplit] V5 complete in ${criticalPathDuration.toFixed(0)}ms`);

      options?.onNostrDelivered?.(nostrEventId);

      // === BACKGROUND PROCESSING ===
      const backgroundPromise = buildResult.startBackground();

      return {
        success: true,
        nostrEventId,
        splitGroupId: buildResult.splitGroupId,
        criticalPathDurationMs: criticalPathDuration,
        backgroundStarted: true,
        backgroundPromise,
      };
    } catch (error) {
      const duration = performance.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[InstantSplit] Failed after ${duration.toFixed(0)}ms:`, error);

      return {
        success: false,
        criticalPathDurationMs: duration,
        error: errorMessage,
        backgroundStarted: false,
      };
    }
  }

  /**
   * Create a TransferCommitment from MintTransactionData WITHOUT waiting for mint proof.
   *
   * Key insight: TransferCommitment.create() only needs token.state and token.nametagTokens.
   * It does NOT need the genesis transaction or mint proof.
   */
  private async createTransferCommitmentFromMintData(
    mintData: MintTransactionData<any>,
    recipientAddress: IAddress,
    transferSalt: Uint8Array,
    signingService: SigningService,
    nametagTokens?: Token<any>[]
  ): Promise<TransferCommitment> {
    // Recreate the predicate from mint data
    const predicate = await UnmaskedPredicate.create(
      mintData.tokenId,
      mintData.tokenType,
      signingService,
      HashAlgorithm.SHA256,
      mintData.salt
    );

    // Create token state (what TransferCommitment.create actually uses)
    const state = new TokenState(predicate, null);

    // Create a minimal token-like object
    // TransferCommitment.create() only accesses token.state and token.nametagTokens
    const minimalToken = {
      state,
      nametagTokens: nametagTokens || [],
      id: mintData.tokenId,
      type: mintData.tokenType,
    };

    // Create the transfer commitment
    const transferCommitment = await TransferCommitment.create(
      minimalToken as any,
      recipientAddress,
      transferSalt,
      null, // recipientData
      null, // recipientDataHash
      signingService
    );

    return transferCommitment;
  }

  /**
   * V5 background submission.
   *
   * Submits mint commitments to aggregator in PARALLEL after transport delivery.
   * Then waits for sender's mint proof, reconstructs change token, and saves it.
   */
  private submitBackgroundV5(
    senderMintCommitment: MintCommitment<any>,
    recipientMintCommitment: MintCommitment<any>,
    transferCommitment: TransferCommitment,
    context: BackgroundContext
  ): Promise<void> {
    console.log('[InstantSplit] Background: Starting parallel mint submission...');
    const startTime = performance.now();

    // Submit all commitments in parallel
    const submissions = Promise.all([
      this.client
        .submitMintCommitment(senderMintCommitment)
        .then((res) => ({ type: 'senderMint', status: res.status }))
        .catch((err) => ({ type: 'senderMint', status: 'ERROR', error: err })),

      this.client
        .submitMintCommitment(recipientMintCommitment)
        .then((res) => ({ type: 'recipientMint', status: res.status }))
        .catch((err) => ({ type: 'recipientMint', status: 'ERROR', error: err })),

      this.client
        .submitTransferCommitment(transferCommitment)
        .then((res) => ({ type: 'transfer', status: res.status }))
        .catch((err) => ({ type: 'transfer', status: 'ERROR', error: err })),
    ]);

    return submissions
      .then(async (results) => {
        const submitDuration = performance.now() - startTime;
        console.log(`[InstantSplit] Background: Submissions complete in ${submitDuration.toFixed(0)}ms`);

        context.onProgress?.({
          stage: 'MINTS_SUBMITTED',
          message: `All commitments submitted in ${submitDuration.toFixed(0)}ms`,
        });

        // Check for critical failures
        const senderMintResult = results.find((r) => r.type === 'senderMint');
        if (
          senderMintResult?.status !== 'SUCCESS' &&
          senderMintResult?.status !== 'REQUEST_ID_EXISTS'
        ) {
          console.error('[InstantSplit] Background: Sender mint failed - cannot save change token');
          context.onProgress?.({
            stage: 'FAILED',
            message: 'Sender mint submission failed',
            error: String((senderMintResult as any)?.error),
          });
          return;
        }

        // Wait for sender's mint proof to save change token
        console.log('[InstantSplit] Background: Waiting for sender mint proof...');
        const proofStartTime = performance.now();

        try {
          const senderMintProof = this.devMode
            ? await this.waitInclusionProofWithDevBypass(senderMintCommitment)
            : await waitInclusionProof(this.trustBase, this.client, senderMintCommitment);

          const proofDuration = performance.now() - proofStartTime;
          console.log(`[InstantSplit] Background: Sender mint proof received in ${proofDuration.toFixed(0)}ms`);

          context.onProgress?.({
            stage: 'MINTS_PROVEN',
            message: `Mint proof received in ${proofDuration.toFixed(0)}ms`,
          });

          // Reconstruct change token
          const mintTransaction = senderMintCommitment.toTransaction(senderMintProof);
          const predicate = await UnmaskedPredicate.create(
            context.senderTokenId,
            context.tokenType,
            context.signingService,
            HashAlgorithm.SHA256,
            context.senderSalt
          );
          const state = new TokenState(predicate, null);
          const changeToken = await Token.mint(this.trustBase, state, mintTransaction);

          // Verify if not in dev mode
          if (!this.devMode) {
            const verification = await changeToken.verify(this.trustBase);
            if (!verification.isSuccessful) {
              throw new Error(`Change token verification failed`);
            }
          }

          console.log('[InstantSplit] Background: Change token created');

          context.onProgress?.({
            stage: 'CHANGE_TOKEN_SAVED',
            message: 'Change token created and verified',
          });

          // Save change token via callback
          if (context.onChangeTokenCreated) {
            await context.onChangeTokenCreated(changeToken);
            console.log('[InstantSplit] Background: Change token saved');
          }

          // Trigger storage sync if provided
          if (context.onStorageSync) {
            try {
              const syncSuccess = await context.onStorageSync();
              console.log(`[InstantSplit] Background: Storage sync ${syncSuccess ? 'completed' : 'deferred'}`);
              context.onProgress?.({
                stage: 'STORAGE_SYNCED',
                message: syncSuccess ? 'Storage synchronized' : 'Sync deferred',
              });
            } catch (syncError) {
              console.warn('[InstantSplit] Background: Storage sync error:', syncError);
            }
          }

          const totalDuration = performance.now() - startTime;
          console.log(`[InstantSplit] Background: Complete in ${totalDuration.toFixed(0)}ms`);

          context.onProgress?.({
            stage: 'COMPLETED',
            message: `Background processing complete in ${totalDuration.toFixed(0)}ms`,
          });
        } catch (proofError) {
          console.error('[InstantSplit] Background: Failed to get sender mint proof:', proofError);
          context.onProgress?.({
            stage: 'FAILED',
            message: 'Failed to get mint proof',
            error: String(proofError),
          });
        }
      })
      .catch((err) => {
        console.error('[InstantSplit] Background: Submission batch failed:', err);
        context.onProgress?.({
          stage: 'FAILED',
          message: 'Background submission failed',
          error: String(err),
        });
      });
  }

  /**
   * Dev mode bypass for waitInclusionProof.
   * In dev mode, we create a mock proof for testing.
   */
  private async waitInclusionProofWithDevBypass(
    commitment: TransferCommitment | MintCommitment<any>,
    timeoutMs = 60000
  ): Promise<any> {
    if (this.devMode) {
      // In dev mode, try to get real proof but with shorter timeout
      try {
        return await Promise.race([
          waitInclusionProof(this.trustBase, this.client, commitment as any),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Dev mode timeout')), Math.min(timeoutMs, 5000))
          ),
        ]);
      } catch {
        // Return a mock proof in dev mode
        console.log('[InstantSplit] Dev mode: Using mock proof');
        return {
          toJSON: () => ({ mock: true }),
        };
      }
    }
    return waitInclusionProof(this.trustBase, this.client, commitment as any);
  }
}

/**
 * Factory function for creating InstantSplitExecutor
 */
export function createInstantSplitExecutor(config: InstantSplitExecutorConfig): InstantSplitExecutor {
  return new InstantSplitExecutor(config);
}
