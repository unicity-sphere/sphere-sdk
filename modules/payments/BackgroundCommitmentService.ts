/**
 * Background Commitment Service
 *
 * Manages background submission of commitments to the aggregator.
 * Supports parallel submissions, proof waiting, and callback notifications.
 *
 * Used by InstantSplitExecutor for fire-and-forget commitment submissions
 * after the critical path (Nostr delivery) completes.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { waitInclusionProof } from '@unicitylabs/state-transition-sdk/lib/util/InclusionProofUtils';
import type {
  BackgroundCommitmentEntry,
  BackgroundCommitmentStatus,
  BackgroundCommitmentCallbacks,
} from '../../types/instant-split';

// =============================================================================
// Types
// =============================================================================

export interface BackgroundCommitmentServiceConfig {
  /** State transition client for aggregator communication */
  stateTransitionClient: any;
  /** Trust base for verification */
  trustBase: any;
  /** Proof wait timeout in ms (default: 60000) */
  proofTimeoutMs?: number;
  /** Enable debug logging */
  debug?: boolean;
}

export interface PendingCommitment {
  /** Unique ID */
  id: string;
  /** Type of commitment */
  type: 'MINT' | 'TRANSFER' | 'BURN';
  /** The commitment object */
  commitment: any;
  /** Associated split group ID */
  splitGroupId: string;
  /** Callbacks */
  callbacks?: BackgroundCommitmentCallbacks;
  /** When added */
  createdAt: number;
  /** Current status */
  status: BackgroundCommitmentStatus;
  /** Inclusion proof (when received) */
  inclusionProof?: any;
  /** Error message */
  error?: string;
}

// =============================================================================
// BackgroundCommitmentService
// =============================================================================

export class BackgroundCommitmentService {
  private client: any;
  private trustBase: any;
  private proofTimeoutMs: number;
  private debug: boolean;

  /** Pending commitments by ID */
  private pending: Map<string, PendingCommitment> = new Map();

  /** Commitments grouped by split group ID */
  private byGroup: Map<string, Set<string>> = new Map();

  /** Global callbacks */
  private globalCallbacks: Set<BackgroundCommitmentCallbacks> = new Set();

  constructor(config: BackgroundCommitmentServiceConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.proofTimeoutMs = config.proofTimeoutMs ?? 60000;
    this.debug = config.debug ?? false;
  }

  /**
   * Submit a commitment in the background.
   * Returns immediately with an entry ID.
   *
   * @param type - Type of commitment (MINT, TRANSFER, BURN)
   * @param commitment - The commitment object
   * @param splitGroupId - Associated split group ID
   * @param callbacks - Optional callbacks for this specific commitment
   * @returns Entry ID for tracking
   */
  submitInBackground(
    type: 'MINT' | 'TRANSFER' | 'BURN',
    commitment: any,
    splitGroupId: string,
    callbacks?: BackgroundCommitmentCallbacks
  ): string {
    const id = this.generateId();
    const entry: PendingCommitment = {
      id,
      type,
      commitment,
      splitGroupId,
      callbacks,
      createdAt: Date.now(),
      status: 'PENDING',
    };

    this.pending.set(id, entry);

    // Track by group
    if (!this.byGroup.has(splitGroupId)) {
      this.byGroup.set(splitGroupId, new Set());
    }
    this.byGroup.get(splitGroupId)!.add(id);

    // Start background processing
    this.processCommitment(entry);

    return id;
  }

  /**
   * Submit multiple commitments in parallel.
   *
   * @param items - Array of commitment items
   * @returns Array of entry IDs
   */
  submitBatch(
    items: Array<{
      type: 'MINT' | 'TRANSFER' | 'BURN';
      commitment: any;
      splitGroupId: string;
    }>,
    callbacks?: BackgroundCommitmentCallbacks
  ): string[] {
    return items.map((item) =>
      this.submitInBackground(item.type, item.commitment, item.splitGroupId, callbacks)
    );
  }

  /**
   * Get status of a specific commitment.
   */
  getStatus(id: string): BackgroundCommitmentEntry | null {
    const entry = this.pending.get(id);
    if (!entry) return null;

    return this.toEntry(entry);
  }

  /**
   * Get all commitments for a split group.
   */
  getGroupStatus(splitGroupId: string): BackgroundCommitmentEntry[] {
    const ids = this.byGroup.get(splitGroupId);
    if (!ids) return [];

    return Array.from(ids)
      .map((id) => this.pending.get(id))
      .filter((e): e is PendingCommitment => e !== undefined)
      .map((e) => this.toEntry(e));
  }

  /**
   * Check if all commitments in a group are complete.
   */
  isGroupComplete(splitGroupId: string): boolean {
    const entries = this.getGroupStatus(splitGroupId);
    return entries.length > 0 && entries.every((e) => e.status === 'COMPLETED' || e.status === 'FAILED');
  }

  /**
   * Wait for all commitments in a group to complete.
   */
  async waitForGroup(splitGroupId: string, timeoutMs = 120000): Promise<BackgroundCommitmentEntry[]> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (this.isGroupComplete(splitGroupId)) {
        return this.getGroupStatus(splitGroupId);
      }
      await this.sleep(500);
    }

    return this.getGroupStatus(splitGroupId);
  }

  /**
   * Register global callbacks for all commitments.
   */
  onCommitment(callbacks: BackgroundCommitmentCallbacks): () => void {
    this.globalCallbacks.add(callbacks);
    return () => this.globalCallbacks.delete(callbacks);
  }

  /**
   * Get all pending commitment IDs.
   */
  getPendingIds(): string[] {
    return Array.from(this.pending.keys()).filter(
      (id) => this.pending.get(id)!.status === 'PENDING' || this.pending.get(id)!.status === 'SUBMITTED'
    );
  }

  /**
   * Clear completed entries older than maxAgeMs.
   */
  cleanup(maxAgeMs = 3600000): number {
    const now = Date.now();
    let removed = 0;

    for (const [id, entry] of this.pending) {
      if (
        (entry.status === 'COMPLETED' || entry.status === 'FAILED') &&
        now - entry.createdAt > maxAgeMs
      ) {
        this.pending.delete(id);
        this.byGroup.get(entry.splitGroupId)?.delete(id);
        removed++;
      }
    }

    return removed;
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private async processCommitment(entry: PendingCommitment): Promise<void> {
    this.log(`Processing ${entry.type} commitment ${entry.id.slice(0, 8)}...`);

    try {
      // Submit to aggregator
      entry.status = 'SUBMITTED';
      const submitMethod = entry.type === 'MINT'
        ? this.client.submitMintCommitment
        : this.client.submitTransferCommitment;

      const response = await submitMethod.call(this.client, entry.commitment);

      if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
        throw new Error(`Submit failed: ${response.status}`);
      }

      this.log(`Commitment ${entry.id.slice(0, 8)} submitted: ${response.status}`);
      this.notifySubmitted(entry);

      // Wait for proof
      const proof = await waitInclusionProof(
        this.trustBase,
        this.client,
        entry.commitment
      );

      entry.inclusionProof = proof;
      entry.status = 'PROOF_RECEIVED';
      this.log(`Commitment ${entry.id.slice(0, 8)} proof received`);
      this.notifyProofReceived(entry, proof);

      // Mark completed
      entry.status = 'COMPLETED';

      // Check if all in group are complete
      if (this.isGroupComplete(entry.splitGroupId)) {
        this.notifyAllComplete(entry.splitGroupId);
      }

    } catch (error) {
      entry.status = 'FAILED';
      entry.error = error instanceof Error ? error.message : String(error);
      this.log(`Commitment ${entry.id.slice(0, 8)} failed:`, error);
      this.notifyError(entry, error instanceof Error ? error : new Error(String(error)));
    }
  }

  private notifySubmitted(entry: PendingCommitment): void {
    const converted = this.toEntry(entry);
    entry.callbacks?.onSubmitted?.(converted);
    for (const cb of this.globalCallbacks) {
      cb.onSubmitted?.(converted);
    }
  }

  private notifyProofReceived(entry: PendingCommitment, proof: any): void {
    const converted = this.toEntry(entry);
    entry.callbacks?.onProofReceived?.(converted, proof);
    for (const cb of this.globalCallbacks) {
      cb.onProofReceived?.(converted, proof);
    }
  }

  private notifyError(entry: PendingCommitment, error: Error): void {
    const converted = this.toEntry(entry);
    entry.callbacks?.onError?.(converted, error);
    for (const cb of this.globalCallbacks) {
      cb.onError?.(converted, error);
    }
  }

  private notifyAllComplete(splitGroupId: string): void {
    const entries = this.getGroupStatus(splitGroupId);

    // Notify entries with their specific callbacks
    for (const id of this.byGroup.get(splitGroupId) ?? []) {
      const entry = this.pending.get(id);
      entry?.callbacks?.onAllComplete?.(entries);
    }

    // Notify global callbacks
    for (const cb of this.globalCallbacks) {
      cb.onAllComplete?.(entries);
    }
  }

  private toEntry(entry: PendingCommitment): BackgroundCommitmentEntry {
    return {
      id: entry.id,
      type: entry.type === 'BURN' ? 'TRANSFER' : entry.type,
      commitmentJson: JSON.stringify(entry.commitment.toJSON?.() ?? entry.commitment),
      status: entry.status,
      splitGroupId: entry.splitGroupId,
      createdAt: entry.createdAt,
      updatedAt: Date.now(),
      inclusionProofJson: entry.inclusionProof
        ? JSON.stringify(entry.inclusionProof.toJSON?.() ?? entry.inclusionProof)
        : undefined,
      error: entry.error,
    };
  }

  private generateId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private log(...args: unknown[]): void {
    if (this.debug) {
      console.log('[BackgroundCommitmentService]', ...args);
    }
  }
}

/**
 * Create a BackgroundCommitmentService instance
 */
export function createBackgroundCommitmentService(
  config: BackgroundCommitmentServiceConfig
): BackgroundCommitmentService {
  return new BackgroundCommitmentService(config);
}
