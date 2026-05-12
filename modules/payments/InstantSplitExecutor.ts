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

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import { hexToBytes as fromHex } from '../../core/hex';
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

// Steelman³⁵: fromHex consolidated to core/hex.ts (top-of-file import).

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
    logger.debug('InstantSplit', `Building V5 bundle for token ${tokenIdHex.slice(0, 8)}...`);

    const coinId = new CoinId(fromHex(coinIdHex));
    // Loop1-S12 — replace Date.now() with a 32-byte cryptographic
    // nonce. The previous millisecond-resolution Date.now() let a
    // recipient who knows tokenIdHex brute-force the send time over a
    // narrow window to derive senderSalt = sha256(seedString +
    // '_sender_salt') — enabling wallet-graph correlation of the
    // sender's change tokens across subsequent transfers. The
    // recipient already learns tokenIdHex from receive flows (it's the
    // source's public id), so this is reachable. A 32-byte nonce
    // raises the brute-force cost beyond practical bounds while
    // keeping all subsequent salt derivations deterministic-from-seed.
    const nonceBytes = new Uint8Array(32);
    crypto.getRandomValues(nonceBytes);
    const nonceHex = toHex(nonceBytes);
    const seedString = `${tokenIdHex}_${splitAmount.toString()}_${remainderAmount.toString()}_${nonceHex}`;

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
    logger.debug('InstantSplit', 'Step 1: Creating and submitting burn...');
    const burnSalt = await sha256(seedString + '_burn_salt');
    const burnCommitment = await split.createBurnCommitment(burnSalt, this.signingService);

    const burnResponse = await this.client.submitTransferCommitment(burnCommitment);
    if (burnResponse.status !== 'SUCCESS' && burnResponse.status !== 'REQUEST_ID_EXISTS') {
      throw new SphereError(`Burn submission failed: ${burnResponse.status}`, 'TRANSFER_FAILED');
    }
    // Loop2-C2 — signal that the burn is durable on-chain. The
    // dispatcher uses this to mark `committedOnChainTokenIds` BEFORE
    // the proof wait, so a timeout/throw downstream still tombstones
    // the source. Wrap in try/catch — caller errors must not break
    // the executor.
    try {
      options?.onBurnSubmitted?.();
    } catch (cbErr) {
      logger.warn('InstantSplit', 'onBurnSubmitted callback threw (swallowed):', cbErr);
    }

    // === STEP 2: WAIT FOR BURN PROOF (~2s) ===
    logger.debug('InstantSplit', 'Step 2: Waiting for burn proof...');
    const burnProof = this.devMode
      ? await this.waitInclusionProofWithDevBypass(burnCommitment, options?.burnProofTimeoutMs)
      : await waitInclusionProof(this.trustBase, this.client, burnCommitment);
    const burnTransaction = burnCommitment.toTransaction(burnProof);

    logger.debug('InstantSplit', 'Burn proof received');

    options?.onBurnCompleted?.(JSON.stringify(burnTransaction.toJSON()));

    // === STEP 3: CREATE MINT COMMITMENTS WITH SPLITMINT REASON ===
    logger.debug('InstantSplit', 'Step 3: Creating mint commitments...');
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
      throw new SphereError('Failed to find expected mint commitments', 'TRANSFER_FAILED');
    }

    // === STEP 4: CREATE TRANSFER COMMITMENT FROM MINT DATA ===
    logger.debug('InstantSplit', 'Step 4: Creating transfer commitment...');
    const transferSalt = await sha256(seedString + '_transfer_salt');

    const transferCommitment = await this.createTransferCommitmentFromMintData(
      recipientMintCommitment.transactionData,
      recipientAddress,
      transferSalt,
      this.signingService,
      undefined, // nametagTokens
      options?.message // on-chain message (invoice memo bytes, or null)
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
    logger.debug('InstantSplit', 'Step 5: Packaging V5 bundle...');
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

    // #142 — pre-compute the artifacts the UXF dispatcher needs to
    // assemble a recipient SDK Token JSON. JSON.stringify/JSON.parse
    // round-trip ensures the data is plain-object (no Uint8Array refs)
    // and matches the shape the UXF bundle ingest expects.
    const recipientMintDataJson = recipientMintCommitment.transactionData.toJSON();
    const recipientMintedStateJson = mintedState.toJSON();
    const transferCommitmentJson = transferCommitment.toJSON() as {
      transactionData?: unknown;
      requestId?: unknown;
    };
    const transferTxDataJson = transferCommitmentJson.transactionData;

    // Loop1-S11 — tighten extraction. `RequestId` extends `DataHash`
    // whose `toJSON()` returns the imprint hex string. The previous
    // `String(requestId)` fallback would ship "[object Object]" if
    // the SDK shape ever changes — silently breaking downstream
    // outbox/finalization joins. Validate hex shape; fail loud on
    // regression.
    const transferRequestIdHexRaw = (transferCommitment.requestId as { toJSON?: () => string })?.toJSON?.();
    if (typeof transferRequestIdHexRaw !== 'string' || !/^[0-9a-f]+$/i.test(transferRequestIdHexRaw)) {
      throw new SphereError(
        `InstantSplitExecutor.buildSplitBundle: transferCommitment.requestId.toJSON() returned non-hex (${typeof transferRequestIdHexRaw}); SDK shape regression?`,
        'TRANSFER_FAILED',
      );
    }
    const transferRequestIdHex = transferRequestIdHexRaw;

    return {
      bundle,
      splitGroupId,
      // Legacy V6 path: submits all three commitments + waits for sender
      // mint proof + constructs change token, all in the background.
      // The UXF path uses submitCommitmentsImmediate +
      // awaitChangeTokenWithProofs instead.
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
      // UXF path: submit-only (no proof waits). Throws on any submission
      // failure so the dispatcher can abort before shipping the bundle.
      submitCommitmentsImmediate: () =>
        this.submitCommitmentsImmediate(
          senderMintCommitment,
          recipientMintCommitment,
          transferCommitment,
        ),
      // UXF path: post-transport background work. Waits for the
      // sender's mint proof, constructs the change token, calls
      // onChangeTokenCreated. Errors are logged inside, never thrown.
      awaitChangeTokenWithProofs: () =>
        this.awaitChangeTokenWithProofs(senderMintCommitment, {
          signingService: this.signingService,
          tokenType: tokenToSplit.type,
          coinId,
          senderTokenId,
          senderSalt,
          onProgress: options?.onBackgroundProgress,
          onChangeTokenCreated: options?.onChangeTokenCreated,
          onStorageSync: options?.onStorageSync,
        }),
      transferRequestIdHex,
      recipientMintDataJson,
      recipientMintedStateJson,
      transferTxDataJson,
    };
  }

  /**
   * #142 — UXF instant-split wiring. Submits the sender mint, recipient
   * mint, and transfer commitments to the aggregator, AWAITS the
   * recipient mint inclusion proof, and returns the proven recipient
   * mint transaction JSON ready for ingestion as a UXF token genesis.
   *
   * **Why we wait for the recipient mint proof here** (Loop4 e2e fix):
   * the UXF bundle format requires every token's genesis to carry a
   * proven `inclusionProof` (see uxf/deconstruct.ts:79 —
   * `GenesisShape.inclusionProof: InclusionProofShape` is non-nullable).
   * Without the proof the sender's `pkg.ingestAll` throws
   * `Cannot read properties of null (reading 'authenticator')` when
   * deconstructing the recipient JSON's genesis. The latency cost is
   * ~one extra aggregator round-trip (~2s typical), bringing the
   * instant-split critical path from ~2.3s to ~4.3s — still well
   * inside the "instant" mode envelope and far below the conservative
   * mode's ~8s+ floor.
   *
   * **Ordering matters (Loop1-S3 steelman fix).** Submissions are
   * SERIAL, not parallel, and ordered to maximize the user's recovery
   * surface on partial failure:
   *
   *   1. Sender mint  — anchors the change token. If this lands and
   *                     a later step fails, the user's residual is
   *                     recoverable via `awaitChangeTokenWithProofs`.
   *                     If this fails, NOTHING else is submitted —
   *                     the user lost only the burn (source is gone),
   *                     no orphan recipient-side commitments pollute
   *                     the aggregator.
   *
   *   2. Recipient mint — mints the recipient slice at the sender's
   *                       predicate. Required before the transfer
   *                       commitment can reference it. If this fails,
   *                       the change token is still recoverable via
   *                       step 1.
   *
   *   3. Transfer commitment — moves the recipient slice from
   *                            sender's predicate to recipient's
   *                            address. If this fails, the recipient
   *                            mint at the sender's predicate is
   *                            recoverable as a sender-owned token
   *                            (manual reassignment); change token
   *                            still recoverable via step 1.
   *
   *   4. Wait for recipient mint inclusion proof. Required by the UXF
   *                            format to populate the genesis
   *                            inclusionProof field.
   *
   * @returns object with `recipientMintProvenGenesisJson` — the JSON
   *          of the proven recipient mint transaction `{data, inclusionProof}`.
   *          The dispatcher uses this as `recipientTokenJson.genesis`.
   *
   * @internal
   */
  private async submitCommitmentsImmediate(
    senderMintCommitment: MintCommitment<any>,
    recipientMintCommitment: MintCommitment<any>,
    transferCommitment: TransferCommitment,
  ): Promise<{ recipientMintProvenGenesisJson: unknown }> {
    logger.debug('InstantSplit', 'submitCommitmentsImmediate: serial submit (senderMint → recipientMint → transfer)');

    const submitOne = async (
      label: string,
      submit: () => Promise<{ status: string }>,
    ): Promise<void> => {
      let res: { status: string };
      try {
        res = await submit();
      } catch (err) {
        // Sanitize the error message before interpolating into the
        // outgoing SphereError — aggregator-supplied strings are not
        // trusted (Loop1 sanitization gap).
        const raw = err instanceof Error ? err.message : String(err);
        const msg = raw.replace(/[\r\n\t\0]/g, ' ').slice(0, 200);
        throw new SphereError(
          `submitCommitmentsImmediate: ${label} submission threw: ${msg}`,
          'TRANSFER_FAILED',
          err,
        );
      }
      if (res.status !== 'SUCCESS' && res.status !== 'REQUEST_ID_EXISTS') {
        throw new SphereError(
          `submitCommitmentsImmediate: ${label} submission rejected with status=${res.status}`,
          'TRANSFER_FAILED',
        );
      }
    };

    await submitOne('senderMint', () => this.client.submitMintCommitment(senderMintCommitment));
    await submitOne('recipientMint', () => this.client.submitMintCommitment(recipientMintCommitment));
    await submitOne('transfer', () => this.client.submitTransferCommitment(transferCommitment));

    logger.debug('InstantSplit', 'submitCommitmentsImmediate: all three commitments anchored; awaiting recipient mint proof');

    // Loop4-e2e — UXF format requires the recipient genesis to be
    // proven. Without this wait, `pkg.ingestAll` throws on the
    // sender side because deconstructInclusionProof can't handle a
    // null inclusionProof on a Genesis shape.
    let recipientMintProof: unknown;
    try {
      recipientMintProof = this.devMode
        ? await this.waitInclusionProofWithDevBypass(recipientMintCommitment)
        : await waitInclusionProof(this.trustBase, this.client, recipientMintCommitment);
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      const msg = raw.replace(/[\r\n\t\0]/g, ' ').slice(0, 200);
      throw new SphereError(
        `submitCommitmentsImmediate: recipient mint proof wait failed: ${msg}`,
        'TRANSFER_FAILED',
        err,
      );
    }

    // Reconstruct the proven recipient mint transaction and serialize
    // for the UXF bundle's genesis.
    const recipientMintTransaction = recipientMintCommitment.toTransaction(recipientMintProof as any);
    const recipientMintProvenGenesisJson = recipientMintTransaction.toJSON();
    logger.debug('InstantSplit', 'submitCommitmentsImmediate: recipient mint proof anchored, genesis ready');
    return { recipientMintProvenGenesisJson };
  }

  /**
   * #142 — UXF instant-split wiring. After commitments are anchored
   * via submitCommitmentsImmediate, this method waits for the sender's
   * mint proof, reconstructs the change token, and invokes
   * onChangeTokenCreated.
   *
   * Errors are caught and logged (NOT re-thrown). The UXF bundle has
   * already shipped by the time this runs; throwing would propagate
   * into a fire-and-forget context with no observer.
   *
   * @internal
   */
  private async awaitChangeTokenWithProofs(
    senderMintCommitment: MintCommitment<any>,
    context: BackgroundContext,
  ): Promise<void> {
    try {
      logger.debug('InstantSplit', 'awaitChangeTokenWithProofs: waiting for sender mint proof');
      const senderMintProof = this.devMode
        ? await this.waitInclusionProofWithDevBypass(senderMintCommitment)
        : await waitInclusionProof(this.trustBase, this.client, senderMintCommitment);

      const mintTransaction = senderMintCommitment.toTransaction(senderMintProof);
      const predicate = await UnmaskedPredicate.create(
        context.senderTokenId,
        context.tokenType,
        context.signingService,
        HashAlgorithm.SHA256,
        context.senderSalt,
      );
      const state = new TokenState(predicate, null);
      const changeToken = await Token.mint(this.trustBase, state, mintTransaction);

      if (!this.devMode) {
        const verification = await changeToken.verify(this.trustBase);
        if (!verification.isSuccessful) {
          throw new SphereError('Change token verification failed', 'TRANSFER_FAILED');
        }
      }

      context.onProgress?.({
        stage: 'CHANGE_TOKEN_SAVED',
        message: 'Change token created and verified',
      });

      if (context.onChangeTokenCreated) {
        await context.onChangeTokenCreated(changeToken);
      }

      if (context.onStorageSync) {
        try {
          await context.onStorageSync();
        } catch (syncError) {
          logger.warn('InstantSplit', 'awaitChangeTokenWithProofs: storage sync error:', syncError);
        }
      }

      context.onProgress?.({
        stage: 'COMPLETED',
        message: 'Change token persisted',
      });
    } catch (err) {
      logger.error('InstantSplit', 'awaitChangeTokenWithProofs: failed', err);
      context.onProgress?.({
        stage: 'FAILED',
        message: 'Change token construction failed',
        error: String(err),
      });
    }
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
      logger.debug('InstantSplit', 'Sending via transport...');
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
      logger.debug('InstantSplit', `V5 complete in ${criticalPathDuration.toFixed(0)}ms`);

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
      logger.error('InstantSplit', `Failed after ${duration.toFixed(0)}ms:`, error);

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
    nametagTokens?: Token<any>[],
    message?: Uint8Array | null
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
      null, // recipientDataHash
      message ?? null, // on-chain message (invoice memo bytes, or null)
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
    logger.debug('InstantSplit', 'Background: Starting parallel mint submission...');
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
        logger.debug('InstantSplit', `Background: Submissions complete in ${submitDuration.toFixed(0)}ms`);

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
          logger.error('InstantSplit', 'Background: Sender mint failed - cannot save change token');
          context.onProgress?.({
            stage: 'FAILED',
            message: 'Sender mint submission failed',
            error: String((senderMintResult as any)?.error),
          });
          return;
        }

        // Wait for sender's mint proof to save change token
        logger.debug('InstantSplit', 'Background: Waiting for sender mint proof...');
        const proofStartTime = performance.now();

        try {
          const senderMintProof = this.devMode
            ? await this.waitInclusionProofWithDevBypass(senderMintCommitment)
            : await waitInclusionProof(this.trustBase, this.client, senderMintCommitment);

          const proofDuration = performance.now() - proofStartTime;
          logger.debug('InstantSplit', `Background: Sender mint proof received in ${proofDuration.toFixed(0)}ms`);

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
              throw new SphereError('Change token verification failed', 'TRANSFER_FAILED');
            }
          }

          logger.debug('InstantSplit', 'Background: Change token created');

          context.onProgress?.({
            stage: 'CHANGE_TOKEN_SAVED',
            message: 'Change token created and verified',
          });

          // Save change token via callback
          if (context.onChangeTokenCreated) {
            await context.onChangeTokenCreated(changeToken);
            logger.debug('InstantSplit', 'Background: Change token saved');
          }

          // Trigger storage sync if provided
          if (context.onStorageSync) {
            try {
              const syncSuccess = await context.onStorageSync();
              logger.debug('InstantSplit', `Background: Storage sync ${syncSuccess ? 'completed' : 'deferred'}`);
              context.onProgress?.({
                stage: 'STORAGE_SYNCED',
                message: syncSuccess ? 'Storage synchronized' : 'Sync deferred',
              });
            } catch (syncError) {
              logger.warn('InstantSplit', 'Background: Storage sync error:', syncError);
            }
          }

          const totalDuration = performance.now() - startTime;
          logger.debug('InstantSplit', `Background: Complete in ${totalDuration.toFixed(0)}ms`);

          context.onProgress?.({
            stage: 'COMPLETED',
            message: `Background processing complete in ${totalDuration.toFixed(0)}ms`,
          });
        } catch (proofError) {
          logger.error('InstantSplit', 'Background: Failed to get sender mint proof:', proofError);
          context.onProgress?.({
            stage: 'FAILED',
            message: 'Failed to get mint proof',
            error: String(proofError),
          });
        }
      })
      .catch((err) => {
        logger.error('InstantSplit', 'Background: Submission batch failed:', err);
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
 * Factory function for creating InstantSplitExecutor
 */
export function createInstantSplitExecutor(config: InstantSplitExecutorConfig): InstantSplitExecutor {
  return new InstantSplitExecutor(config);
}
