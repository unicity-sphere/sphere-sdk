/**
 * BackgroundCommitmentService
 *
 * Manages background submission of commitments to the aggregator.
 * Used by InstantSplitExecutor to handle non-critical path operations.
 *
 * Features:
 * - Parallel submission of multiple commitments
 * - Status tracking per split group
 * - Retry logic for transient failures
 * - Callbacks for progress updates
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { logger } from '../../core/logger';
import { SphereError } from '../../core/errors';
import type { MintCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/MintCommitment';
import type { TransferCommitment } from '@unicitylabs/state-transition-sdk/lib/transaction/TransferCommitment';
import type { StateTransitionClient } from '@unicitylabs/state-transition-sdk/lib/StateTransitionClient';
import type { RootTrustBase } from '@unicitylabs/state-transition-sdk/lib/bft/RootTrustBase';

// =============================================================================
// Types
// =============================================================================

export type BackgroundTaskType = 'MINT_SUBMISSION' | 'TRANSFER_SUBMISSION' | 'PROOF_WAIT' | 'TOKEN_PERSIST';

export type BackgroundTaskStatus = 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

/**
 * A background task to be executed
 */
export interface BackgroundTask {
  id: string;
  type: BackgroundTaskType;
  splitGroupId: string;
  status: BackgroundTaskStatus;
  retryCount: number;
  maxRetries: number;
  data: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Status of a split group's background processing
 */
export interface GroupStatus {
  splitGroupId: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'PARTIAL' | 'FAILED';
  tasks: BackgroundTask[];
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

/**
 * Callbacks for background processing events
 */
export interface BackgroundCallbacks {
  onTaskStarted?: (task: BackgroundTask) => void;
  onTaskCompleted?: (task: BackgroundTask) => void;
  onTaskFailed?: (task: BackgroundTask, error: string) => void;
  onGroupCompleted?: (status: GroupStatus) => void;
  onGroupFailed?: (status: GroupStatus, error: string) => void;
}

/**
 * Configuration for BackgroundCommitmentService
 */
export interface BackgroundCommitmentServiceConfig {
  stateTransitionClient: StateTransitionClient;
  trustBase: RootTrustBase;
  /** Default max retries for tasks (default: 3) */
  maxRetries?: number;
  /** Dev mode skips trust base verification */
  devMode?: boolean;
}

// =============================================================================
// Implementation
// =============================================================================

export class BackgroundCommitmentService {
  private client: StateTransitionClient;
  private trustBase: RootTrustBase;
  private maxRetries: number;
  private devMode: boolean;
  private groups: Map<string, GroupStatus> = new Map();
  private pendingPromises: Map<string, Promise<GroupStatus>> = new Map();

  constructor(config: BackgroundCommitmentServiceConfig) {
    this.client = config.stateTransitionClient;
    this.trustBase = config.trustBase;
    this.maxRetries = config.maxRetries ?? 3;
    this.devMode = config.devMode ?? false;
  }

  /**
   * Submit a single mint commitment in the background.
   *
   * @param commitment - The mint commitment to submit
   * @param splitGroupId - Group ID for tracking
   * @param callbacks - Optional callbacks for progress updates
   * @returns Task ID
   */
  submitMintInBackground(
    commitment: MintCommitment<any>,
    splitGroupId: string,
    callbacks?: BackgroundCallbacks
  ): string {
    const taskId = crypto.randomUUID();
    const task: BackgroundTask = {
      id: taskId,
      type: 'MINT_SUBMISSION',
      splitGroupId,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: this.maxRetries,
      data: commitment,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.addTaskToGroup(splitGroupId, task);
    this.executeTask(task, callbacks);

    return taskId;
  }

  /**
   * Submit a single transfer commitment in the background.
   *
   * @param commitment - The transfer commitment to submit
   * @param splitGroupId - Group ID for tracking
   * @param callbacks - Optional callbacks for progress updates
   * @returns Task ID
   */
  submitTransferInBackground(
    commitment: TransferCommitment,
    splitGroupId: string,
    callbacks?: BackgroundCallbacks
  ): string {
    const taskId = crypto.randomUUID();
    const task: BackgroundTask = {
      id: taskId,
      type: 'TRANSFER_SUBMISSION',
      splitGroupId,
      status: 'PENDING',
      retryCount: 0,
      maxRetries: this.maxRetries,
      data: commitment,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.addTaskToGroup(splitGroupId, task);
    this.executeTask(task, callbacks);

    return taskId;
  }

  /**
   * Submit a batch of commitments in parallel.
   *
   * @param commitments - Array of mint or transfer commitments
   * @param splitGroupId - Group ID for tracking
   * @param callbacks - Optional callbacks for progress updates
   * @returns Array of task IDs
   */
  submitBatch(
    commitments: Array<MintCommitment<any> | TransferCommitment>,
    splitGroupId: string,
    callbacks?: BackgroundCallbacks
  ): string[] {
    const taskIds: string[] = [];

    for (const commitment of commitments) {
      const taskId = crypto.randomUUID();
      const isMint = 'transactionData' in commitment && 'tokenId' in (commitment as any).transactionData;
      const task: BackgroundTask = {
        id: taskId,
        type: isMint ? 'MINT_SUBMISSION' : 'TRANSFER_SUBMISSION',
        splitGroupId,
        status: 'PENDING',
        retryCount: 0,
        maxRetries: this.maxRetries,
        data: commitment,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };

      this.addTaskToGroup(splitGroupId, task);
      taskIds.push(taskId);
    }

    // Execute all tasks in parallel
    const group = this.groups.get(splitGroupId)!;
    for (const task of group.tasks) {
      if (task.status === 'PENDING') {
        this.executeTask(task, callbacks);
      }
    }

    return taskIds;
  }

  /**
   * Get the status of a split group.
   *
   * @param splitGroupId - Group ID to check
   * @returns Group status or undefined if not found
   */
  getGroupStatus(splitGroupId: string): GroupStatus | undefined {
    return this.groups.get(splitGroupId);
  }

  /**
   * Wait for a split group to complete.
   *
   * @param splitGroupId - Group ID to wait for
   * @param timeoutMs - Maximum wait time in ms (default: 120000)
   * @returns Final group status
   */
  async waitForGroup(splitGroupId: string, timeoutMs = 120000): Promise<GroupStatus> {
    const existing = this.pendingPromises.get(splitGroupId);
    if (existing) {
      return existing;
    }

    const group = this.groups.get(splitGroupId);
    if (!group) {
      throw new SphereError(`Unknown split group: ${splitGroupId}`, 'VALIDATION_ERROR');
    }

    if (group.status === 'COMPLETED' || group.status === 'FAILED') {
      return group;
    }

    const promise = new Promise<GroupStatus>((resolve, reject) => {
      const startTime = Date.now();

      const checkStatus = () => {
        const current = this.groups.get(splitGroupId);
        if (!current) {
          reject(new Error(`Group disappeared: ${splitGroupId}`));
          return;
        }

        if (current.status === 'COMPLETED' || current.status === 'FAILED') {
          this.pendingPromises.delete(splitGroupId);
          resolve(current);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          this.pendingPromises.delete(splitGroupId);
          reject(new Error(`Timeout waiting for group: ${splitGroupId}`));
          return;
        }

        setTimeout(checkStatus, 500);
      };

      checkStatus();
    });

    this.pendingPromises.set(splitGroupId, promise);
    return promise;
  }

  /**
   * Cancel all pending tasks for a split group.
   *
   * @param splitGroupId - Group ID to cancel
   */
  cancelGroup(splitGroupId: string): void {
    const group = this.groups.get(splitGroupId);
    if (!group) return;

    for (const task of group.tasks) {
      if (task.status === 'PENDING' || task.status === 'IN_PROGRESS') {
        task.status = 'FAILED';
        task.error = 'Cancelled';
        task.updatedAt = Date.now();
      }
    }

    group.status = 'FAILED';
    group.error = 'Cancelled';
    this.pendingPromises.delete(splitGroupId);
  }

  // =============================================================================
  // Private Methods
  // =============================================================================

  private addTaskToGroup(splitGroupId: string, task: BackgroundTask): void {
    let group = this.groups.get(splitGroupId);
    if (!group) {
      group = {
        splitGroupId,
        status: 'PENDING',
        tasks: [],
        startedAt: Date.now(),
      };
      this.groups.set(splitGroupId, group);
    }
    group.tasks.push(task);
  }

  private async executeTask(task: BackgroundTask, callbacks?: BackgroundCallbacks): Promise<void> {
    const group = this.groups.get(task.splitGroupId)!;
    group.status = 'IN_PROGRESS';

    task.status = 'IN_PROGRESS';
    task.updatedAt = Date.now();
    callbacks?.onTaskStarted?.(task);

    try {
      if (task.type === 'MINT_SUBMISSION') {
        await this.submitMintCommitment(task.data as MintCommitment<any>);
      } else if (task.type === 'TRANSFER_SUBMISSION') {
        await this.submitTransferCommitment(task.data as TransferCommitment);
      }

      task.status = 'COMPLETED';
      task.updatedAt = Date.now();
      callbacks?.onTaskCompleted?.(task);
    } catch (error) {
      task.retryCount++;
      task.updatedAt = Date.now();

      if (task.retryCount < task.maxRetries) {
        // Retry with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, task.retryCount - 1), 10000);
        logger.debug('BackgroundCommit', `Task ${task.id.slice(0, 8)} failed, retrying in ${delay}ms`);
        task.status = 'PENDING';
        setTimeout(() => this.executeTask(task, callbacks), delay);
        return;
      }

      task.status = 'FAILED';
      task.error = error instanceof Error ? error.message : String(error);
      callbacks?.onTaskFailed?.(task, task.error);
    }

    this.updateGroupStatus(task.splitGroupId, callbacks);
  }

  private async submitMintCommitment(commitment: MintCommitment<any>): Promise<void> {
    const response = await this.client.submitMintCommitment(commitment);
    if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
      throw new SphereError(`Mint submission failed: ${response.status}`, 'TRANSFER_FAILED');
    }
  }

  private async submitTransferCommitment(commitment: TransferCommitment): Promise<void> {
    const response = await this.client.submitTransferCommitment(commitment);
    if (response.status !== 'SUCCESS' && response.status !== 'REQUEST_ID_EXISTS') {
      throw new SphereError(`Transfer submission failed: ${response.status}`, 'TRANSFER_FAILED');
    }
  }

  private updateGroupStatus(splitGroupId: string, callbacks?: BackgroundCallbacks): void {
    const group = this.groups.get(splitGroupId);
    if (!group) return;

    const completed = group.tasks.filter((t) => t.status === 'COMPLETED').length;
    const failed = group.tasks.filter((t) => t.status === 'FAILED').length;
    const total = group.tasks.length;

    if (completed === total) {
      group.status = 'COMPLETED';
      group.completedAt = Date.now();
      callbacks?.onGroupCompleted?.(group);
    } else if (failed > 0 && completed + failed === total) {
      if (completed > 0) {
        group.status = 'PARTIAL';
      } else {
        group.status = 'FAILED';
      }
      group.completedAt = Date.now();
      group.error = `${failed} of ${total} tasks failed`;
      callbacks?.onGroupFailed?.(group, group.error);
    }
  }
}

/**
 * Factory function for creating BackgroundCommitmentService
 */
export function createBackgroundCommitmentService(
  config: BackgroundCommitmentServiceConfig
): BackgroundCommitmentService {
  return new BackgroundCommitmentService(config);
}
