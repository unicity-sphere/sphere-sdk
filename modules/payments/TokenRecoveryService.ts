/**
 * TokenRecoveryService
 *
 * Recovers tokens from failed or incomplete instant split operations.
 *
 * Recovery Scenarios:
 * 1. Orphaned splits: Burn completed but mints never submitted
 * 2. Lost change tokens: Mints completed but change token never saved
 * 3. Sent tokens: Recover tokens from sent Nostr events
 *
 * This service works with the storage provider to persist recovered tokens.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Token } from '@unicitylabs/state-transition-sdk/lib/token/Token';
import { TokenId } from '@unicitylabs/state-transition-sdk/lib/token/TokenId';
import { TokenState } from '@unicitylabs/state-transition-sdk/lib/token/TokenState';
import { TokenType } from '@unicitylabs/state-transition-sdk/lib/token/TokenType';
import { CoinId } from '@unicitylabs/state-transition-sdk/lib/token/fungible/CoinId';
import { HashAlgorithm } from '@unicitylabs/state-transition-sdk/lib/hash/HashAlgorithm';
import { UnmaskedPredicate } from '@unicitylabs/state-transition-sdk/lib/predicate/embedded/UnmaskedPredicate';
import { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import { MintTransactionData } from '@unicitylabs/state-transition-sdk/lib/transaction/MintTransactionData';
import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type { SigningService } from '@unicitylabs/state-transition-sdk/lib/sign/SigningService';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';

import type {
  InstantSplitBundleV5,
  InstantSplitV5RecoveryMetadata,
  SplitRecoveryResult,
} from '../../types/instant-split';
import type { TransportProvider } from '../../transport';
import type { StorageProvider } from '../../storage';

// =============================================================================
// Types
// =============================================================================

export interface TokenRecoveryServiceConfig {
  stateTransitionClient: StateTransitionClient;
  trustBase: RootTrustBase;
  signingService: SigningService;
  /** Dev mode skips trust base verification */
  devMode?: boolean;
}

export interface RecoveryDependencies {
  stClient: StateTransitionClient;
  trustBase: RootTrustBase;
  signingService: SigningService;
  devMode?: boolean;
}

/**
 * An outbox entry with V5 recovery metadata
 */
export interface V5OutboxEntry {
  id: string;
  splitGroupId: string;
  status: string;
  metadata?: InstantSplitV5RecoveryMetadata;
  bundleJson?: string;
}

/**
 * Options for recovering sent tokens
 */
export interface RecoverSentOptions {
  /** Unix timestamp to start scanning from (default: 30 days ago) */
  since?: number;
  /** Maximum number of events to scan (default: 100) */
  limit?: number;
}

// =============================================================================
// Utility Functions
// =============================================================================

async function sha256(input: string | Uint8Array): Promise<Uint8Array> {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buffer = new ArrayBuffer(data.length);
  new Uint8Array(buffer).set(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return new Uint8Array(hashBuffer);
}

function fromHex(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// =============================================================================
// Implementation
// =============================================================================

export class TokenRecoveryService {
  private client: StateTransitionClient;
  private trustBase: RootTrustBase;
  private signingService: SigningService;
  private devMode: boolean;

  constructor(config: TokenRecoveryServiceConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.signingService = config.signingService;
    this.devMode = config.devMode ?? false;
  }

  /**
   * Recover change tokens from orphaned V5 splits.
   *
   * This scans outbox entries to find splits where:
   * - Nostr delivery succeeded
   * - But change token was never saved (browser crash, etc.)
   *
   * @param outboxEntries - Array of V5 outbox entries to check
   * @param onTokenRecovered - Callback when a token is recovered
   * @returns Recovery result
   */
  async recoverOrphanedSplits(
    outboxEntries: V5OutboxEntry[],
    onTokenRecovered?: (token: Token<any>, splitGroupId: string) => Promise<void>
  ): Promise<SplitRecoveryResult> {
    const startTime = performance.now();
    const result: SplitRecoveryResult = {
      splitsRecovered: 0,
      changeTokensRecovered: 0,
      errors: [],
      durationMs: 0,
    };

    for (const entry of outboxEntries) {
      // Only process entries that were sent but not completed
      if (entry.status !== 'NOSTR_SENT' && entry.status !== 'SENT') {
        continue;
      }

      const metadata = entry.metadata;
      if (!metadata || metadata.version !== '5.0') {
        continue;
      }

      try {
        console.log(`[Recovery] Processing orphaned split ${entry.splitGroupId}`);

        // Reconstruct the sender's mint commitment from metadata
        const senderTokenId = new TokenId(fromHex(metadata.senderTokenIdHex));
        const senderSalt = fromHex(metadata.senderSaltHex);

        // Try to get the mint proof from the aggregator
        // This will succeed if the background submission completed before crash
        const changeToken = await this.tryRecoverChangeToken(
          metadata.seedString,
          senderTokenId,
          senderSalt,
          metadata.changeAmount,
          entry.bundleJson
        );

        if (changeToken) {
          await onTokenRecovered?.(changeToken, entry.splitGroupId);
          result.changeTokensRecovered++;
          result.splitsRecovered++;
          console.log(`[Recovery] Recovered change token for split ${entry.splitGroupId}`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        result.errors.push({
          splitGroupId: entry.splitGroupId,
          error: errorMessage,
          timestamp: Date.now(),
        });
        console.error(`[Recovery] Failed to recover split ${entry.splitGroupId}:`, error);
      }
    }

    result.durationMs = performance.now() - startTime;
    console.log(`[Recovery] Completed in ${result.durationMs.toFixed(0)}ms: ${result.changeTokensRecovered} tokens recovered`);

    return result;
  }

  /**
   * Try to recover a change token by checking if the mint proof exists.
   *
   * @param seedString - Original seed string used for split
   * @param senderTokenId - Token ID for the change token
   * @param senderSalt - Salt for the change token
   * @param changeAmount - Amount of the change token
   * @param bundleJson - Optional bundle JSON for additional context
   * @returns Recovered token or null
   */
  private async tryRecoverChangeToken(
    seedString: string,
    senderTokenId: TokenId,
    senderSalt: Uint8Array,
    changeAmount: string,
    bundleJson?: string
  ): Promise<Token<any> | null> {
    try {
      // Parse bundle for token type if available
      let tokenType: TokenType | undefined;
      let coinId: CoinId | undefined;

      if (bundleJson) {
        const bundle = JSON.parse(bundleJson) as InstantSplitBundleV5;
        tokenType = new TokenType(fromHex(bundle.tokenTypeHex));
        coinId = new CoinId(fromHex(bundle.coinId));
      }

      if (!tokenType) {
        console.log('[Recovery] Cannot recover: no token type available');
        return null;
      }

      // Create the predicate for the change token
      const predicate = await UnmaskedPredicate.create(
        senderTokenId,
        tokenType,
        this.signingService,
        HashAlgorithm.SHA256,
        senderSalt
      );
      const state = new TokenState(predicate, null);

      // Try to get the proof from the aggregator
      // The mint was submitted in background, so it might exist
      // We need to recreate the MintTransactionData to create the commitment
      // For V5 recovery, we'd need the full mint data which is in the background context

      // This is a simplified recovery - in production, you'd need to store
      // the full MintCommitment JSON in the outbox for complete recovery
      console.log('[Recovery] Would attempt to recover change token - mint proof lookup not implemented');
      return null;
    } catch (error) {
      console.warn('[Recovery] Failed to recover change token:', error);
      return null;
    }
  }

  /**
   * Recover tokens from sent Nostr events.
   *
   * This scans outgoing Nostr events to reconstruct tokens that were sent
   * but may not be properly reflected in local storage.
   *
   * @param transport - Transport provider to query events
   * @param options - Recovery options
   * @returns Recovery result
   */
  async recoverSentTokens(
    transport: TransportProvider,
    options?: RecoverSentOptions
  ): Promise<SplitRecoveryResult> {
    const startTime = performance.now();
    const result: SplitRecoveryResult = {
      splitsRecovered: 0,
      changeTokensRecovered: 0,
      errors: [],
      durationMs: 0,
    };

    // Note: Full implementation would query Nostr for sent events
    // and cross-reference with local storage to find missing tokens
    console.log('[Recovery] Sent token recovery not fully implemented');

    result.durationMs = performance.now() - startTime;
    return result;
  }

  /**
   * Recover from a split where the burn completed but mints failed.
   *
   * This is a critical recovery scenario - the original token is burned,
   * but the new tokens were never created. We attempt to recreate them.
   *
   * @param splitGroupId - The split group ID
   * @param burnRequestIdHex - The burn transaction request ID
   * @param seedString - The seed string used for split calculations
   * @param tokenType - The token type
   * @param coinId - The coin ID
   * @param splitAmount - Amount for recipient
   * @param changeAmount - Amount for sender
   * @returns Recovery result
   */
  async recoverSplitBurnFailure(
    splitGroupId: string,
    burnRequestIdHex: string,
    seedString: string,
    tokenType: TokenType,
    coinId: CoinId,
    splitAmount: bigint,
    changeAmount: bigint,
    onTokenRecovered?: (token: Token<any>, isChange: boolean) => Promise<void>
  ): Promise<SplitRecoveryResult> {
    const startTime = performance.now();
    const result: SplitRecoveryResult = {
      splitsRecovered: 0,
      changeTokensRecovered: 0,
      errors: [],
      durationMs: 0,
    };

    try {
      console.log(`[Recovery] Attempting burn failure recovery for ${splitGroupId}`);

      // Regenerate the token IDs and salts
      const recipientTokenId = new TokenId(await sha256(seedString));
      const senderTokenId = new TokenId(await sha256(seedString + '_sender'));
      const recipientSalt = await sha256(seedString + '_recipient_salt');
      const senderSalt = await sha256(seedString + '_sender_salt');

      // Note: Full recovery would require:
      // 1. Querying the aggregator for the burn transaction
      // 2. Recreating the mint commitments with SplitMintReason
      // 3. Submitting the mints if not already submitted
      // 4. Waiting for proofs and creating the tokens

      // This is a complex operation that depends on the specific failure mode
      console.log('[Recovery] Burn failure recovery not fully implemented');
      console.log(`[Recovery] Would recover: ${toHex(senderTokenId.bytes).slice(0, 16)}... (change)`);

      result.errors.push({
        splitGroupId,
        error: 'Burn failure recovery not fully implemented',
        timestamp: Date.now(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.errors.push({
        splitGroupId,
        error: errorMessage,
        timestamp: Date.now(),
      });
    }

    result.durationMs = performance.now() - startTime;
    return result;
  }

  /**
   * Verify a token still exists and is valid on the aggregator.
   *
   * @param token - The token to verify
   * @returns true if token is valid, false otherwise
   */
  async verifyTokenExists(token: Token<any>): Promise<boolean> {
    try {
      if (this.devMode) {
        return true;
      }

      const verification = await token.verify(this.trustBase);
      return verification.isSuccessful;
    } catch {
      return false;
    }
  }
}

/**
 * Factory function for creating TokenRecoveryService
 */
export function createTokenRecoveryService(config: TokenRecoveryServiceConfig): TokenRecoveryService {
  return new TokenRecoveryService(config);
}
