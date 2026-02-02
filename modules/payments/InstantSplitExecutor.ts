/**
 * Instant Split Executor
 *
 * Implements INSTANT_SPLIT V5 - production-mode instant token splits.
 * Achieves ~2.3s sender-side latency vs ~42s for synchronous splits.
 *
 * INSTANT_SPLIT V5 Flow:
 * 1. Create burn commitment (local)
 * 2. Submit burn → wait proof (~2s) ← SDK requires burn proof for SplitMintReason
 * 3. Create mint commitments with SplitMintReason (requires burn proof)
 * 4. Create transfer commitment (NO mint proof needed!) ← KEY OPTIMIZATION
 * 5. Package InstantSplitBundleV5
 * 6. Send via Nostr to recipient (~0.3s)
 * 7. Return SUCCESS to caller (background continues)
 *
 * Background (non-blocking):
 * 8. Submit mint commitments (parallel)
 * 9. Wait for mint proofs (parallel)
 * 10. Save change token
 * 11. Sync to storage
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

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
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import type { IAddress } from '@unicitylabs/state-transition-sdk/lib/address/IAddress';
import type { TransferTransaction } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransaction';

import type {
  InstantSplitBundleV5,
  InstantSplitResult,
  InstantSplitOptions,
  InstantSplitProgress,
  InstantSplitStage,
  BackgroundCommitmentCallbacks,
} from '../../types/instant-split';
import type { SplitPaymentSession } from '../../types/payment-session';
import { createSplitPaymentSession, updatePaymentSession } from '../../types/payment-session';

// =============================================================================
// Types
// =============================================================================

export interface InstantSplitExecutorConfig {
  /** State transition client for aggregator communication */
  stateTransitionClient: any;
  /** Trust base for verification */
  trustBase: any;
  /** Signing service for commitments */
  signingService: SigningService;
  /** Enable debug logging */
  debug?: boolean;
}

export interface InstantSplitExecutorDependencies {
  /** Function to send bundle via Nostr */
  sendViaNostr: (recipientPubkey: string, bundle: InstantSplitBundleV5) => Promise<string>;
  /** Function to save change token */
  saveChangeToken?: (token: Token<any>) => Promise<void>;
  /** Function to trigger storage sync */
  triggerStorageSync?: () => Promise<boolean>;
}

interface MintInfo {
  commitment: MintCommitment<any>;
  tokenId: TokenId;
  salt: Uint8Array;
  isForRecipient: boolean;
}

// =============================================================================
// Helper Functions
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

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// =============================================================================
// InstantSplitExecutor
// =============================================================================

export class InstantSplitExecutor {
  private client: any;
  private trustBase: any;
  private signingService: SigningService;
  private debug: boolean;

  constructor(config: InstantSplitExecutorConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.signingService = config.signingService;
    this.debug = config.debug ?? false;
  }

  /**
   * Execute an instant split with V5 protocol.
   *
   * @param tokenToSplit - The SDK token to split
   * @param splitAmount - Amount for recipient
   * @param remainderAmount - Amount for sender (change)
   * @param coinIdHex - Coin ID in hex
   * @param recipientAddress - Recipient's address
   * @param deps - External dependencies (Nostr send, storage callbacks)
   * @param options - Optional configuration
   * @returns Result with session ID and delivery status
   */
  async executeSplitInstant(
    tokenToSplit: Token<any>,
    splitAmount: bigint,
    remainderAmount: bigint,
    coinIdHex: string,
    recipientAddress: IAddress,
    deps: InstantSplitExecutorDependencies,
    options?: InstantSplitOptions
  ): Promise<InstantSplitResult> {
    const startTime = performance.now();
    const splitGroupId = generateUUID();

    // Create session for tracking
    const session = createSplitPaymentSession({
      sourceTokenId: toHex(tokenToSplit.id.bytes),
      paymentAmount: splitAmount.toString(),
      changeAmount: remainderAmount.toString(),
      splitGroupId,
    });

    this.emitProgress(options, 'INITIATED', 'Split session created');

    try {
      // Execute V5 split flow
      const result = await this.executeV5Split(
        tokenToSplit,
        splitAmount,
        remainderAmount,
        coinIdHex,
        recipientAddress,
        splitGroupId,
        deps,
        session,
        options
      );

      return result;
    } catch (error) {
      const duration = performance.now() - startTime;
      this.log('Instant split failed:', error);
      this.emitProgress(options, 'FAILED', `Split failed: ${error}`);

      return {
        success: false,
        sessionId: session.id,
        splitGroupId,
        criticalPathDurationMs: duration,
        backgroundStarted: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Internal V5 split implementation
   */
  private async executeV5Split(
    tokenToSplit: Token<any>,
    splitAmount: bigint,
    remainderAmount: bigint,
    coinIdHex: string,
    recipientAddress: IAddress,
    splitGroupId: string,
    deps: InstantSplitExecutorDependencies,
    session: SplitPaymentSession,
    options?: InstantSplitOptions
  ): Promise<InstantSplitResult> {
    const v5StartTime = performance.now();

    const tokenIdHex = toHex(tokenToSplit.id.bytes);
    const coinId = new CoinId(fromHex(coinIdHex));
    const seedString = `${tokenIdHex}_${splitAmount.toString()}_${remainderAmount.toString()}`;

    this.log(`Splitting token ${tokenIdHex.slice(0, 8)}...`);

    // Generate deterministic IDs and salts
    const recipientTokenId = new TokenId(await sha256(seedString));
    const senderTokenId = new TokenId(await sha256(seedString + '_sender'));
    const recipientSalt = await sha256(seedString + '_recipient_salt');
    const senderSalt = await sha256(seedString + '_sender_salt');
    const burnSalt = await sha256(seedString + '_burn_salt');
    const transferSalt = await sha256(seedString + '_transfer_salt');

    // Create sender address (mints go to sender first, then transfer to recipient)
    const senderAddressRef = await UnmaskedPredicateReference.create(
      tokenToSplit.type,
      this.signingService.algorithm,
      this.signingService.publicKey,
      HashAlgorithm.SHA256
    );
    const senderAddress = await senderAddressRef.toAddress();

    // Build split using SDK builder
    const builder = new TokenSplitBuilder();

    const coinDataA = TokenCoinData.create([[coinId, splitAmount]]);
    builder.createToken(
      recipientTokenId,
      tokenToSplit.type,
      new Uint8Array(0),
      coinDataA,
      senderAddress, // Mint to sender, then transfer
      recipientSalt,
      null
    );

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

    // === STEP 1: Create and submit burn commitment ===
    this.log('Step 1: Creating and submitting burn commitment...');
    this.emitProgress(options, 'BURN_SUBMITTED', 'Burn commitment submitted');

    const burnCommitment = await split.createBurnCommitment(burnSalt, this.signingService);
    const burnResponse = await this.client.submitTransferCommitment(burnCommitment);

    if (burnResponse.status !== 'SUCCESS' && burnResponse.status !== 'REQUEST_ID_EXISTS') {
      throw new Error(`Burn failed: ${burnResponse.status}`);
    }

    // === STEP 2: Wait for burn inclusion proof (~2s) ===
    this.log('Step 2: Waiting for burn proof...');
    const burnInclusionProof = await waitInclusionProof(this.trustBase, this.client, burnCommitment);
    const burnTransaction = burnCommitment.toTransaction(burnInclusionProof);

    const burnProofDuration = performance.now() - v5StartTime;
    this.log(`Burn proof received in ${burnProofDuration.toFixed(0)}ms`);
    this.emitProgress(options, 'BURN_PROOF_RECEIVED', `Burn proof received in ${burnProofDuration.toFixed(0)}ms`);

    updatePaymentSession(session, {
      phases: { ...session.phases, burn: 'CONFIRMED' },
      timing: { ...session.timing, burnConfirmedAt: Date.now() },
    });

    // === STEP 3: Create mint commitments with SplitMintReason ===
    this.log('Step 3: Creating mint commitments with SplitMintReason...');
    const mintCommitments = await split.createSplitMintCommitments(
      this.trustBase,
      burnTransaction
    );

    // Find recipient and sender mint commitments
    const recipientIdHex = toHex(recipientTokenId.bytes);
    const senderIdHex = toHex(senderTokenId.bytes);

    const recipientMintCommitment = mintCommitments.find(
      (c: MintCommitment<any>) => toHex(c.transactionData.tokenId.bytes) === recipientIdHex
    );
    const senderMintCommitment = mintCommitments.find(
      (c: MintCommitment<any>) => toHex(c.transactionData.tokenId.bytes) === senderIdHex
    );

    if (!recipientMintCommitment || !senderMintCommitment) {
      throw new Error('Failed to find expected mint commitments');
    }

    this.emitProgress(options, 'MINTS_CREATED', 'Mint commitments created');

    // === STEP 4: Create transfer commitment (NO mint proof needed!) ===
    this.log('Step 4: Creating transfer commitment from mint data...');
    const transferCommitment = await this.createTransferCommitmentFromMintData(
      recipientMintCommitment.transactionData,
      recipientAddress,
      transferSalt
    );

    this.emitProgress(options, 'TRANSFER_CREATED', 'Transfer commitment created');

    // === STEP 5: Create minted token state for recipient reconstruction ===
    const mintedPredicate = await UnmaskedPredicate.create(
      recipientTokenId,
      tokenToSplit.type,
      this.signingService,
      HashAlgorithm.SHA256,
      recipientSalt
    );
    const mintedState = new TokenState(mintedPredicate, null);

    // === STEP 6: Package V5 bundle ===
    this.log('Step 5: Packaging V5 bundle...');
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
      senderPubkey: toHex(this.signingService.publicKey),
      recipientSaltHex: toHex(recipientSalt),
      transferSaltHex: toHex(transferSalt),
      mintedTokenStateJson: JSON.stringify(mintedState.toJSON()),
      finalRecipientStateJson: '', // Recipient creates their own
      recipientAddressJson: recipientAddress.toString(),
    };

    this.emitProgress(options, 'BUNDLE_PACKAGED', 'V5 bundle packaged');

    // === STEP 7: Send via Nostr ===
    this.log('Step 6: Sending via Nostr...');
    this.emitProgress(options, 'NOSTR_SENDING', 'Sending via Nostr...');

    let nostrEventId: string;
    try {
      // Use recipient pubkey from address if available, otherwise derive
      const recipientPubkey = (recipientAddress as any).publicKey
        ? toHex((recipientAddress as any).publicKey)
        : session.recipientPubkey ?? '';

      nostrEventId = await deps.sendViaNostr(recipientPubkey, bundle);
    } catch (nostrError) {
      this.log('Nostr delivery failed:', nostrError);
      throw new Error(`Nostr delivery failed: ${nostrError}`);
    }

    const nostrDuration = performance.now() - v5StartTime;
    this.log(`V5 bundle sent via Nostr (${nostrEventId.slice(0, 8)}...) in ${nostrDuration.toFixed(0)}ms`);
    this.emitProgress(options, 'NOSTR_DELIVERED', `Bundle sent via Nostr in ${nostrDuration.toFixed(0)}ms`);

    updatePaymentSession(session, {
      phases: { ...session.phases, transfer: 'NOSTR_DELIVERED' },
      timing: { ...session.timing, nostrDeliveredAt: Date.now() },
    });

    // === STEP 8: Start background processing ===
    if (!options?.skipBackgroundAggregator) {
      this.emitProgress(options, 'BACKGROUND_STARTED', 'Background processing started');

      this.submitBackgroundV5(
        senderMintCommitment,
        recipientMintCommitment,
        transferCommitment,
        {
          senderTokenId,
          senderSalt,
          tokenType: tokenToSplit.type,
          coinId,
          deps,
          options,
        }
      );
    }

    return {
      success: true,
      sessionId: session.id,
      splitGroupId,
      nostrEventId,
      criticalPathDurationMs: nostrDuration,
      backgroundStarted: !options?.skipBackgroundAggregator,
    };
  }

  /**
   * Create a TransferCommitment from MintTransactionData WITHOUT waiting for mint proof.
   *
   * KEY OPTIMIZATION: TransferCommitment.create() only needs token.state and token.nametagTokens.
   * It does NOT need the genesis transaction or mint proof.
   */
  private async createTransferCommitmentFromMintData(
    mintData: MintTransactionData<any>,
    recipientAddress: IAddress,
    transferSalt: Uint8Array
  ): Promise<TransferCommitment> {
    // Recreate the predicate from mint data
    const predicate = await UnmaskedPredicate.create(
      mintData.tokenId,
      mintData.tokenType,
      this.signingService,
      HashAlgorithm.SHA256,
      mintData.salt
    );

    // Create token state (what TransferCommitment.create actually uses)
    const state = new TokenState(predicate, null);

    // Create a minimal token-like object
    // TransferCommitment.create() only accesses token.state and token.nametagTokens
    const minimalToken = {
      state,
      nametagTokens: [],
      id: mintData.tokenId,
      type: mintData.tokenType,
    };

    this.log(`Creating TransferCommitment from mint data (no mint proof required)`);

    // Create the transfer commitment
    const transferCommitment = await TransferCommitment.create(
      minimalToken as any,
      recipientAddress,
      transferSalt,
      null,
      null,
      this.signingService
    );

    return transferCommitment;
  }

  /**
   * Background V5 processing: submit mints and save change token.
   * Runs after Nostr delivery succeeds.
   */
  private submitBackgroundV5(
    senderMintCommitment: MintCommitment<any>,
    recipientMintCommitment: MintCommitment<any>,
    transferCommitment: TransferCommitment,
    context: {
      senderTokenId: TokenId;
      senderSalt: Uint8Array;
      tokenType: any;
      coinId: CoinId;
      deps: InstantSplitExecutorDependencies;
      options?: InstantSplitOptions;
    }
  ): void {
    this.log('Background V5: Starting parallel mint submission...');
    const startTime = performance.now();

    // Submit mints and transfer in parallel (idempotent)
    const submissions = Promise.all([
      this.client.submitMintCommitment(senderMintCommitment)
        .then((res: any) => {
          this.log(`Background: Sender mint submitted: ${res.status}`);
          return { type: 'senderMint', status: res.status };
        })
        .catch((err: any) => {
          this.log(`Background: Sender mint error: ${err}`);
          return { type: 'senderMint', status: 'ERROR', error: err };
        }),

      this.client.submitMintCommitment(recipientMintCommitment)
        .then((res: any) => {
          this.log(`Background: Recipient mint submitted: ${res.status}`);
          return { type: 'recipientMint', status: res.status };
        })
        .catch((err: any) => {
          this.log(`Background: Recipient mint error: ${err}`);
          return { type: 'recipientMint', status: 'ERROR', error: err };
        }),

      this.client.submitTransferCommitment(transferCommitment)
        .then((res: any) => {
          this.log(`Background: Transfer submitted: ${res.status}`);
          return { type: 'transfer', status: res.status };
        })
        .catch((err: any) => {
          this.log(`Background: Transfer error: ${err}`);
          return { type: 'transfer', status: 'ERROR', error: err };
        }),
    ]);

    submissions.then(async (results) => {
      const submitDuration = performance.now() - startTime;
      this.log(`Background: All submissions complete in ${submitDuration.toFixed(0)}ms`);
      this.emitProgress(context.options, 'BACKGROUND_MINTS_SUBMITTED', 'Background mints submitted');

      // Check for critical failures
      const senderMintResult = results.find((r) => r.type === 'senderMint');
      if (senderMintResult?.status !== 'SUCCESS' && senderMintResult?.status !== 'REQUEST_ID_EXISTS') {
        this.log('Background: Sender mint failed - change token may need recovery');
        return;
      }

      // Wait for sender's mint proof to save change token
      this.log('Background: Waiting for sender mint proof...');
      const proofStartTime = performance.now();

      try {
        const senderMintProof = await waitInclusionProof(
          this.trustBase,
          this.client,
          senderMintCommitment
        );
        const proofDuration = performance.now() - proofStartTime;
        this.log(`Background: Sender mint proof received in ${proofDuration.toFixed(0)}ms`);
        this.emitProgress(context.options, 'BACKGROUND_PROOFS_RECEIVED', 'Background proofs received');

        // Reconstruct and save change token
        this.log('Background: Saving change token...');
        const changeToken = await this.createAndVerifyToken(
          senderMintCommitment,
          senderMintProof,
          context.senderTokenId,
          context.senderSalt,
          context.tokenType
        );

        if (context.deps.saveChangeToken) {
          await context.deps.saveChangeToken(changeToken);
          this.log('Background: Change token saved');
          this.emitProgress(context.options, 'CHANGE_TOKEN_SAVED', 'Change token saved');
        }

        // Trigger storage sync
        if (context.deps.triggerStorageSync) {
          this.log('Background: Triggering storage sync...');
          try {
            await context.deps.triggerStorageSync();
            this.log('Background: Storage sync completed');
          } catch (syncError) {
            this.log('Background: Storage sync failed (will retry later):', syncError);
          }
        }

        const totalDuration = performance.now() - startTime;
        this.log(`Background V5: Complete in ${totalDuration.toFixed(0)}ms`);
        this.emitProgress(context.options, 'COMPLETED', `Background complete in ${totalDuration.toFixed(0)}ms`);

      } catch (proofError) {
        this.log('Background: Failed to get sender mint proof:', proofError);
        // Change token is on blockchain - can be recovered later
      }
    }).catch((err) => {
      this.log('Background: Submission batch failed:', err);
    });
  }

  /**
   * Helper to reconstruct and verify a token from mint info
   */
  private async createAndVerifyToken(
    commitment: MintCommitment<any>,
    inclusionProof: any,
    tokenId: TokenId,
    salt: Uint8Array,
    tokenType: any
  ): Promise<Token<any>> {
    const predicate = await UnmaskedPredicate.create(
      tokenId,
      tokenType,
      this.signingService,
      HashAlgorithm.SHA256,
      salt
    );

    const state = new TokenState(predicate, null);
    const genesisTransaction = commitment.toTransaction(inclusionProof);

    const token = await Token.mint(
      this.trustBase,
      state,
      genesisTransaction
    );

    const verification = await token.verify(this.trustBase);
    if (!verification.isSuccessful) {
      throw new Error(`Token verification failed: ${verification}`);
    }

    return token;
  }

  /**
   * Emit progress update
   */
  private emitProgress(
    options: InstantSplitOptions | undefined,
    stage: InstantSplitStage,
    message: string,
    data?: Record<string, unknown>
  ): void {
    if (options?.onProgress) {
      options.onProgress({
        stage,
        message,
        timestamp: Date.now(),
        data,
      });
    }
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[InstantSplitExecutor]', ...args);
    }
  }
}

/**
 * Create an InstantSplitExecutor instance
 */
export function createInstantSplitExecutor(config: InstantSplitExecutorConfig): InstantSplitExecutor {
  return new InstantSplitExecutor(config);
}
