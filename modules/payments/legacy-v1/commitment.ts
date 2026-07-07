/**
 * @internal Phase 5 [C] quarantine — Phase 6.C deletes this file wholesale.
 * v1-STSDK commitment machinery.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type { Token, TrackedAddress, AddressInfo } from '../../../types';
import type { OracleProvider } from '../../../oracle';
import type { IncomingTokenTransfer } from '../../../transport';
import { hexToBytes as fromHex, bytesToHex } from '../../../core/hex';
import { logger } from '../../../core/logger';
import { SphereError } from '../../../core/errors';
import { sanitizeReasonString } from '../../../core/error-sanitize';
import { extractTokenIdFromSdkData } from '../tokens';
import { PredicateEngineService } from '@unicitylabs/state-transition-sdk/lib/predicate/PredicateEngineService';
import { Token as SdkToken } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import { TransferTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferTransactionData';
import { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import { AddressScheme } from '@unicitylabs/state-transition-sdk/lib/address/AddressScheme';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import type { IAddress } from '@unicitylabs/state-transition-sdk/lib/address/IAddress';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';

// ==============================================================================
// submitCommitmentClassified
// ==============================================================================

export async function submitCommitmentClassifiedImpl(this: any, 
    stClient: StateTransitionClient,
    oracle: OracleProvider | undefined,
    commitment: TransferCommitment,
    classify: {
      readonly tokenId: string;
      readonly intendedRecipient: string;
    },
  ): Promise<void> {
    const submitResponse = await stClient.submitTransferCommitment(commitment);
    if (
      submitResponse.status === 'SUCCESS' ||
      submitResponse.status === 'REQUEST_ID_EXISTS'
    ) {
      return;
    }

    // Non-success arc — disambiguate "state already spent by another
    // commit" from generic failures via an authoritative oracle
    // re-query against the source state hash.
    //
    // Issue #243 / #245 #1 — pass owner pubkey alongside stateHash.
    // Derive the publicKey from the commitment's actual source-state
    // predicate (the canonical aggregator requestId basis). The
    // commitment we constructed carries the source-state predicate
    // directly, so this is more precise than wrapping `chainPubkey`
    // (which is wrong for multi-address wallets where the source
    // predicate was built under a different address).
    let isSpent = false;
    let sourceStateHashHex: string | null = null;
    if (oracle !== undefined && typeof oracle.isSpent === 'function') {
      try {
        const sourceStateHashObj = await commitment.transactionData.sourceState.calculateHash();
        sourceStateHashHex = sourceStateHashObj.toJSON();
        // Best-effort predicate-publicKey extraction. The fallback to
        // `chainPubkey` preserves the legacy assumption for wallet-
        // owned source states; a partial / mocked commitment without
        // a `.predicate` field must NOT skip the isSpent probe.
        let ownerPubkey: string = this.deps!.identity.chainPubkey;
        const sourceState = commitment.transactionData.sourceState as
          | { predicate?: unknown }
          | undefined;
        const sourcePredicate = sourceState?.predicate;
        if (sourcePredicate !== undefined && sourcePredicate !== null) {
          const pubkeyBytes = (sourcePredicate as { publicKey?: unknown }).publicKey;
          if (pubkeyBytes instanceof Uint8Array && pubkeyBytes.length > 0) {
            ownerPubkey = bytesToHex(pubkeyBytes);
          }
        }
        isSpent = await oracle.isSpent(ownerPubkey, sourceStateHashHex);
      } catch (probeErr) {
        // The probe is best-effort. If it throws (e.g. aggregator
        // offline), we fall through to the generic
        // `TRANSFER_FAILED` rather than emitting a false-positive
        // double-spend event. Operators see the original commit
        // failure in the standard error stream.
        logger.warn(
          'Payments',
          `submitCommitmentClassified: oracle.isSpent probe threw — falling back to generic TRANSFER_FAILED: ${probeErr instanceof Error ? probeErr.message : String(probeErr)}`,
        );
      }
    }

    if (isSpent && sourceStateHashHex !== null) {
      // The L3 aggregator anchored a competing commit for this source
      // state. Surface as the typed code so the dispatcher's outer
      // catch can emit `transfer:double-spend-detected` for operator
      // visibility. The structured payload travels through
      // `cause` — read by the outer catch to populate the event
      // payload's `sourceStateHash` and `ourIntendedRecipient`.
      throw new SphereError(
        `Transfer commitment lost race for source state ${sourceStateHashHex.slice(0, 16)}…: ` +
          `aggregator confirmed source token ${classify.tokenId.slice(0, 16)}… is already spent ` +
          `by another commit (submit returned ${submitResponse.status}).`,
        'STATE_ALREADY_SPENT_BY_OTHER',
        {
          tokenId: classify.tokenId,
          sourceStateHash: sourceStateHashHex,
          ourIntendedRecipient: classify.intendedRecipient,
          submitStatus: submitResponse.status,
        },
      );
    }

    throw new SphereError(
      `Transfer commitment failed: ${submitResponse.status}`,
      'TRANSFER_FAILED',
    );
}

// ==============================================================================
// createSdkCommitment
// ==============================================================================

export async function createSdkCommitmentImpl(this: any, 
    token: Token,
    recipientAddress: IAddress,
    signingService: SigningService,
    onChainMessage?: Uint8Array | null
  ): Promise<TransferCommitment> {
    // Parse SDK token from stored data
    const tokenData = token.sdkData
      ? (typeof token.sdkData === 'string' ? JSON.parse(token.sdkData) : token.sdkData)
      : token;

    const sdkToken = await SdkToken.fromJSON(tokenData);

    // Generate random salt
    const salt = crypto.getRandomValues(new Uint8Array(32));

    // Create transfer commitment
    const commitment = await TransferCommitment.create(
      sdkToken,
      recipientAddress,
      salt,
      null, // recipientDataHash
      onChainMessage ?? null, // on-chain message bytes
      signingService
    );

    return commitment;
}

// ==============================================================================
// createSigningService
// ==============================================================================

export async function createSigningServiceImpl(this: any): Promise<SigningService> {
    const privateKeyHex = this.deps!.identity.privateKey;
    const privateKeyBytes = fromHex(privateKeyHex);
    const signingService = await SigningService.createFromSecret(privateKeyBytes);
    // Side-effect: cache `signingService.publicKey` as lowercase hex so
    // the synchronous `latestStatePredicateMatchesWallet` (called by the
    // PR #146 balance-model invariant in `loadFromStorageData`) can run
    // without async work. The cache is invalidated by `clear()` /
    // identity reset. See `_signingPublicKeyHex` field doc.
    if (this._signingPublicKeyHex === null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pkBytes = (signingService as any).publicKey;
        if (pkBytes instanceof Uint8Array) {
          this._signingPublicKeyHex = Array.from(pkBytes)
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('');
        }
      } catch {
        // Best-effort. The fallback in latestStatePredicateMatchesWallet
        // uses identity.chainPubkey when this cache stays null.
      }
    }
    return signingService;
}

// ==============================================================================
// handleCommitmentOnlyTransfer
// ==============================================================================

export async function handleCommitmentOnlyTransferImpl(this: any, 
    transfer: IncomingTokenTransfer,
    payload: Record<string, unknown>
  ): Promise<void> {
    try {
      const sourceTokenInput = typeof payload.sourceToken === 'string'
        ? JSON.parse(payload.sourceToken as string)
        : payload.sourceToken;
      const commitmentInput = typeof payload.commitmentData === 'string'
        ? JSON.parse(payload.commitmentData as string)
        : payload.commitmentData;

      if (!sourceTokenInput || !commitmentInput) {
        logger.warn('Payments', 'Invalid NOSTR-FIRST transfer format');
        return;
      }

      const token = await this.saveCommitmentOnlyToken(
        sourceTokenInput,
        commitmentInput,
        transfer.senderTransportPubkey,
      );
      if (!token) return;

      // Resolve sender info for both event and history
      const senderInfo = await this.resolveSenderInfo(transfer.senderTransportPubkey);

      // Emit event for incoming transfer (even though unconfirmed)
      this.deps!.emitEvent('transfer:incoming', {
        id: transfer.id,
        senderPubkey: transfer.senderTransportPubkey,
        senderNametag: senderInfo.senderNametag,
        tokens: [token],
        memo: payload.memo as string | undefined,
        receivedAt: transfer.timestamp,
      });

      // Record in history immediately
      const nostrTokenId = extractTokenIdFromSdkData(token.sdkData);
      await this.addToHistory({
        type: 'RECEIVED',
        amount: token.amount,
        coinId: token.coinId,
        symbol: token.symbol,
        timestamp: Date.now(),
        senderPubkey: transfer.senderTransportPubkey,
        ...senderInfo,
        memo: payload.memo as string | undefined,
        tokenId: nostrTokenId || token.id,
      });
    } catch (error) {
      logger.error('Payments', 'Failed to process NOSTR-FIRST transfer:', error);
    }
}

// ==============================================================================
// resolveExpectedTransactionAddress
// ==============================================================================

export async function resolveExpectedTransactionAddressImpl(this: any, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recipientAddress: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    nametagTokens: SdkToken<any>[],
  ): Promise<string | null> {
    try {
      if (recipientAddress?.scheme === AddressScheme.PROXY) {
        const { ProxyAddress } = await import('@unicitylabs/state-transition-sdk/lib/address/ProxyAddress');
        const resolved = await ProxyAddress.resolve(recipientAddress, nametagTokens);
        return resolved?.address ?? null;
      }
      return typeof recipientAddress?.address === 'string'
        ? recipientAddress.address
        : null;
    } catch (err) {
      logger.debug(
        'Payments',
        `[FINALIZE-RECOVER] resolveExpectedTransactionAddress threw: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
}

// ==============================================================================
// tryRecoverSigningServiceForRecipient
// ==============================================================================

export async function tryRecoverSigningServiceForRecipientImpl(this: any, 
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sourceToken: SdkToken<any>,
    transferSalt: Uint8Array,
    expectedTransactionAddress: string,
  ): Promise<{ signer: SigningService; index: number } | null> {
    const deriveFn = this.deps?.deriveAddressInfo;
    const getAddressesFn = this.deps?.getActiveAddresses;
    if (!deriveFn || !getAddressesFn) return null;

    let tracked: ReadonlyArray<TrackedAddress>;
    try {
      tracked = getAddressesFn();
    } catch (err) {
      logger.debug(
        'Payments',
        `[FINALIZE-RECOVER] getActiveAddresses threw: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }

    const currentChainPubkey = this.deps?.identity?.chainPubkey;
    for (const entry of tracked) {
      // Skip the current active address — its signer was already tried
      // and produced the mismatch we're recovering from.
      if (currentChainPubkey && entry.chainPubkey === currentChainPubkey) {
        continue;
      }
      let addressInfo: AddressInfo;
      try {
        addressInfo = deriveFn(entry.index);
      } catch (err) {
        logger.debug(
          'Payments',
          `[FINALIZE-RECOVER] deriveAddressInfo(${entry.index}) threw: ${(err as Error)?.message ?? err}`,
        );
        continue;
      }
      let candidateSigner: SigningService;
      try {
        candidateSigner = await SigningService.createFromSecret(
          fromHex(addressInfo.privateKey),
        );
      } catch (err) {
        logger.debug(
          'Payments',
          `[FINALIZE-RECOVER] SigningService.createFromSecret(idx=${entry.index}) threw: ${(err as Error)?.message ?? err}`,
        );
        continue;
      }
      const candidateAddr = await this.deriveRecipientAddressFor(
        candidateSigner,
        sourceToken,
        transferSalt,
      );
      if (candidateAddr !== null && candidateAddr === expectedTransactionAddress) {
        return { signer: candidateSigner, index: entry.index };
      }
    }
    return null;
}
