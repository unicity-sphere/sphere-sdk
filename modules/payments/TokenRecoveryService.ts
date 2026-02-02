/**
 * Token Recovery Service
 *
 * Handles recovery of tokens from various failure scenarios:
 * - Orphaned splits (app crash during split operation)
 * - Sent tokens (localStorage loss, need to recover from Nostr)
 * - Failed burn recovery (burn succeeded but mints failed)
 *
 * Recovery scenarios:
 * 1. ORPHANED_SPLIT: Burn committed but mints not completed
 *    - Recovery: Find burn proof, recreate mints, complete split
 *
 * 2. SENT_TOKEN_RECOVERY: Wallet data lost, tokens sent via Nostr
 *    - Recovery: Query Nostr for sent events, reconstruct tokens
 *
 * 3. SPLIT_BURN_FAILURE: Burn submitted but proof never received
 *    - Recovery: Check if burn is on-chain, either retry or restore
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type {
  BackgroundCommitmentEntry,
} from '../../types/instant-split';

// =============================================================================
// Types
// =============================================================================

export interface TokenRecoveryServiceConfig {
  /** State transition client for aggregator communication */
  stateTransitionClient: any;
  /** Trust base for verification */
  trustBase: any;
  /** Nostr service for querying sent events (optional) */
  nostrService?: any;
  /** Storage for outbox entries */
  storage: RecoveryStorage;
  /** Enable debug logging */
  debug?: boolean;
}

export interface RecoveryStorage {
  /** Get all outbox entries */
  getOutboxEntries(): Promise<OutboxEntry[]>;
  /** Update outbox entry */
  updateOutboxEntry(entry: OutboxEntry): Promise<void>;
  /** Remove outbox entry */
  removeOutboxEntry(id: string): Promise<void>;
  /** Get all sent entries */
  getSentEntries?(): Promise<SentEntry[]>;
}

export interface OutboxEntry {
  /** Entry ID */
  id: string;
  /** Type of outbox entry */
  type: 'SPLIT' | 'DIRECT_TRANSFER' | 'INSTANT_SPLIT';
  /** Split group ID (for correlating split phases) */
  splitGroupId?: string;
  /** Current status */
  status: OutboxEntryStatus;
  /** Token ID being sent */
  sourceTokenId: string;
  /** Amount being sent */
  amount: string;
  /** Recipient pubkey */
  recipientPubkey?: string;
  /** Recipient nametag */
  recipientNametag?: string;
  /** Serialized commitment (if any) */
  commitmentJson?: string;
  /** Serialized burn transaction (for V5 instant splits) */
  burnTransactionJson?: string;
  /** Serialized mint commitments */
  mintCommitmentsJson?: string[];
  /** Nostr event ID (if sent) */
  nostrEventId?: string;
  /** Created timestamp */
  createdAt: number;
  /** Updated timestamp */
  updatedAt: number;
  /** Error message (if failed) */
  error?: string;
  /** Retry count */
  retryCount?: number;
}

export type OutboxEntryStatus =
  | 'PENDING'
  | 'BURN_SUBMITTED'
  | 'BURN_CONFIRMED'
  | 'MINTS_SUBMITTED'
  | 'MINTS_CONFIRMED'
  | 'NOSTR_SENT'
  | 'COMPLETED'
  | 'FAILED'
  | 'ORPHANED';

export interface SentEntry {
  /** Entry ID */
  id: string;
  /** Nostr event ID */
  nostrEventId: string;
  /** Serialized token data */
  tokenJson: string;
  /** Recipient pubkey */
  recipientPubkey: string;
  /** Sent timestamp */
  sentAt: number;
}

export interface RecoveryResult {
  /** Whether recovery was successful */
  success: boolean;
  /** Number of items recovered */
  recoveredCount: number;
  /** Number of items failed */
  failedCount: number;
  /** Details of recovered items */
  recovered: RecoveredItem[];
  /** Errors encountered */
  errors: RecoveryError[];
}

export interface RecoveredItem {
  /** Item type */
  type: 'SPLIT' | 'DIRECT_TRANSFER' | 'INSTANT_SPLIT' | 'SENT_TOKEN';
  /** Original entry ID */
  entryId: string;
  /** Token ID (if applicable) */
  tokenId?: string;
  /** Amount */
  amount?: string;
  /** Recovery action taken */
  action: string;
}

export interface RecoveryError {
  /** Entry ID */
  entryId: string;
  /** Error message */
  message: string;
  /** Whether retry is possible */
  retryable: boolean;
}

// =============================================================================
// TokenRecoveryService
// =============================================================================

export class TokenRecoveryService {
  private client: any;
  private trustBase: any;
  private nostrService: any;
  private storage: RecoveryStorage;
  private debug: boolean;

  constructor(config: TokenRecoveryServiceConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.nostrService = config.nostrService;
    this.storage = config.storage;
    this.debug = config.debug ?? false;
  }

  /**
   * Recover all orphaned splits.
   * Scans outbox for entries that were interrupted during split operation.
   */
  async recoverOrphanedSplits(): Promise<RecoveryResult> {
    this.log('Starting orphaned split recovery...');

    const result: RecoveryResult = {
      success: true,
      recoveredCount: 0,
      failedCount: 0,
      recovered: [],
      errors: [],
    };

    try {
      const entries = await this.storage.getOutboxEntries();

      // Find orphaned entries
      const orphaned = entries.filter(
        (e) =>
          (e.type === 'SPLIT' || e.type === 'INSTANT_SPLIT') &&
          e.status !== 'COMPLETED' &&
          e.status !== 'FAILED'
      );

      this.log(`Found ${orphaned.length} orphaned split entries`);

      for (const entry of orphaned) {
        try {
          const recovered = await this.recoverSplitEntry(entry);
          if (recovered) {
            result.recoveredCount++;
            result.recovered.push({
              type: entry.type as 'SPLIT' | 'INSTANT_SPLIT',
              entryId: entry.id,
              tokenId: entry.sourceTokenId,
              amount: entry.amount,
              action: 'Recovered orphaned split',
            });
          }
        } catch (error) {
          result.failedCount++;
          result.errors.push({
            entryId: entry.id,
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          });
        }
      }

      result.success = result.failedCount === 0;

    } catch (error) {
      result.success = false;
      this.log('Recovery failed:', error);
    }

    this.log(`Recovery complete: ${result.recoveredCount} recovered, ${result.failedCount} failed`);
    return result;
  }

  /**
   * Recover sent tokens from Nostr.
   * Used when wallet data is lost but tokens were previously sent.
   */
  async recoverSentTokens(options?: {
    since?: number;
    limit?: number;
  }): Promise<RecoveryResult> {
    this.log('Starting sent token recovery from Nostr...');

    const result: RecoveryResult = {
      success: true,
      recoveredCount: 0,
      failedCount: 0,
      recovered: [],
      errors: [],
    };

    if (!this.nostrService) {
      this.log('Nostr service not available - skipping sent token recovery');
      return result;
    }

    try {
      // Query Nostr for sent token events
      const since = options?.since ?? Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
      const limit = options?.limit ?? 100;

      const events = await this.querySentTokenEvents(since, limit);
      this.log(`Found ${events.length} sent token events`);

      for (const event of events) {
        try {
          const recovered = await this.recoverSentTokenFromEvent(event);
          if (recovered) {
            result.recoveredCount++;
            result.recovered.push({
              type: 'SENT_TOKEN',
              entryId: event.id,
              action: 'Recovered sent token from Nostr',
            });
          }
        } catch (error) {
          result.failedCount++;
          result.errors.push({
            entryId: event.id,
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
        }
      }

      result.success = result.failedCount === 0;

    } catch (error) {
      result.success = false;
      this.log('Sent token recovery failed:', error);
    }

    return result;
  }

  /**
   * Recover a failed split burn.
   * Used when burn was submitted but proof was never received.
   */
  async recoverSplitBurnFailure(splitGroupId: string): Promise<RecoveryResult> {
    this.log(`Recovering split burn failure for group: ${splitGroupId}`);

    const result: RecoveryResult = {
      success: false,
      recoveredCount: 0,
      failedCount: 0,
      recovered: [],
      errors: [],
    };

    try {
      const entries = await this.storage.getOutboxEntries();
      const entry = entries.find(
        (e) => e.splitGroupId === splitGroupId && e.status === 'BURN_SUBMITTED'
      );

      if (!entry) {
        this.log('No matching burn entry found');
        result.errors.push({
          entryId: splitGroupId,
          message: 'No matching burn entry found',
          retryable: false,
        });
        return result;
      }

      // Try to recover the burn
      const recovered = await this.recoverBurnPhase(entry);

      if (recovered) {
        result.success = true;
        result.recoveredCount = 1;
        result.recovered.push({
          type: 'SPLIT',
          entryId: entry.id,
          tokenId: entry.sourceTokenId,
          amount: entry.amount,
          action: 'Recovered burn phase',
        });
      } else {
        result.failedCount = 1;
        result.errors.push({
          entryId: entry.id,
          message: 'Failed to recover burn phase',
          retryable: true,
        });
      }

    } catch (error) {
      result.errors.push({
        entryId: splitGroupId,
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      });
    }

    return result;
  }

  /**
   * Get recovery status for a split group.
   */
  async getRecoveryStatus(splitGroupId: string): Promise<{
    status: OutboxEntryStatus;
    entry?: OutboxEntry;
    canRecover: boolean;
    recommendation: string;
  }> {
    const entries = await this.storage.getOutboxEntries();
    const entry = entries.find((e) => e.splitGroupId === splitGroupId);

    if (!entry) {
      return {
        status: 'COMPLETED',
        canRecover: false,
        recommendation: 'No entry found - either completed or never started',
      };
    }

    const canRecover =
      entry.status !== 'COMPLETED' &&
      entry.status !== 'FAILED' &&
      (entry.retryCount ?? 0) < 3;

    let recommendation = '';
    switch (entry.status) {
      case 'PENDING':
        recommendation = 'Split never started - safe to retry';
        break;
      case 'BURN_SUBMITTED':
        recommendation = 'Burn in progress - wait or check aggregator';
        break;
      case 'BURN_CONFIRMED':
        recommendation = 'Burn confirmed - can continue with mints';
        break;
      case 'MINTS_SUBMITTED':
        recommendation = 'Mints in progress - wait or check aggregator';
        break;
      case 'MINTS_CONFIRMED':
        recommendation = 'Mints confirmed - can send via Nostr';
        break;
      case 'NOSTR_SENT':
        recommendation = 'Sent via Nostr - wait for confirmation';
        break;
      case 'ORPHANED':
        recommendation = 'Orphaned entry - recovery recommended';
        break;
      default:
        recommendation = 'Unknown state';
    }

    return {
      status: entry.status,
      entry,
      canRecover,
      recommendation,
    };
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async recoverSplitEntry(entry: OutboxEntry): Promise<boolean> {
    this.log(`Recovering split entry: ${entry.id}, status: ${entry.status}`);

    switch (entry.status) {
      case 'PENDING':
        // Never started - mark as orphaned for manual recovery
        entry.status = 'ORPHANED';
        await this.storage.updateOutboxEntry(entry);
        return false;

      case 'BURN_SUBMITTED':
        // Check if burn is on-chain
        return this.recoverBurnPhase(entry);

      case 'BURN_CONFIRMED':
        // Continue with mints
        return this.recoverMintPhase(entry);

      case 'MINTS_SUBMITTED':
        // Check if mints are on-chain
        return this.recoverMintPhase(entry);

      case 'MINTS_CONFIRMED':
        // Resend via Nostr
        return this.recoverNostrPhase(entry);

      case 'NOSTR_SENT':
        // Mark as completed
        entry.status = 'COMPLETED';
        await this.storage.updateOutboxEntry(entry);
        return true;

      default:
        return false;
    }
  }

  private async recoverBurnPhase(entry: OutboxEntry): Promise<boolean> {
    if (!entry.commitmentJson) {
      this.log('No burn commitment found for entry');
      return false;
    }

    try {
      // Parse the commitment
      const commitmentData = JSON.parse(entry.commitmentJson);

      // Check if proof exists on-chain
      const requestId = commitmentData.requestId;
      if (!requestId) {
        this.log('No request ID in commitment');
        return false;
      }

      // Query for inclusion proof
      const proof = await this.client.getInclusionProof?.(requestId);

      if (proof) {
        this.log('Burn proof found on-chain');
        entry.status = 'BURN_CONFIRMED';
        entry.updatedAt = Date.now();
        await this.storage.updateOutboxEntry(entry);
        return true;
      }

      // Proof not found - retry submission
      this.log('Burn proof not found - would need to retry');
      return false;

    } catch (error) {
      this.log('Failed to recover burn phase:', error);
      return false;
    }
  }

  private async recoverMintPhase(entry: OutboxEntry): Promise<boolean> {
    if (!entry.mintCommitmentsJson || entry.mintCommitmentsJson.length === 0) {
      this.log('No mint commitments found for entry');
      return false;
    }

    try {
      // Check all mints
      let allConfirmed = true;

      for (const mintJson of entry.mintCommitmentsJson) {
        const mintData = JSON.parse(mintJson);
        const requestId = mintData.requestId;

        if (!requestId) continue;

        const proof = await this.client.getInclusionProof?.(requestId);
        if (!proof) {
          allConfirmed = false;
          break;
        }
      }

      if (allConfirmed) {
        this.log('All mints confirmed');
        entry.status = 'MINTS_CONFIRMED';
        entry.updatedAt = Date.now();
        await this.storage.updateOutboxEntry(entry);
        return true;
      }

      return false;

    } catch (error) {
      this.log('Failed to recover mint phase:', error);
      return false;
    }
  }

  private async recoverNostrPhase(entry: OutboxEntry): Promise<boolean> {
    // Nostr resend would require the full bundle
    // For now, just mark as needing manual intervention
    this.log('Nostr phase recovery not yet implemented');
    entry.status = 'ORPHANED';
    entry.updatedAt = Date.now();
    await this.storage.updateOutboxEntry(entry);
    return false;
  }

  private async querySentTokenEvents(since: number, limit: number): Promise<any[]> {
    if (!this.nostrService?.queryEvents) {
      return [];
    }

    try {
      return await this.nostrService.queryEvents({
        kinds: [24133], // Token transfer kind
        since: Math.floor(since / 1000),
        limit,
      });
    } catch {
      return [];
    }
  }

  private async recoverSentTokenFromEvent(event: any): Promise<boolean> {
    // Parse event and reconstruct token
    // This is a placeholder - actual implementation depends on event structure
    this.log(`Would recover token from event: ${event.id}`);
    return false;
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[TokenRecoveryService]', ...args);
    }
  }
}

/**
 * Create a TokenRecoveryService instance
 */
export function createTokenRecoveryService(
  config: TokenRecoveryServiceConfig
): TokenRecoveryService {
  return new TokenRecoveryService(config);
}
