/**
 * Write-Behind Buffer for IpfsStorageProvider
 *
 * Provides non-blocking writes via double-buffering and a promise-chain
 * serial queue. Writes are accepted immediately into a pending buffer
 * and flushed to IPFS asynchronously in the background.
 */

import type { TxfStorageDataBase } from '../../../storage';

// =============================================================================
// AsyncSerialQueue
// =============================================================================

/**
 * Promise-chain-based async mutex. Serializes async operations
 * without external dependencies. Each enqueued operation waits for
 * the previous one to complete before starting.
 */
export class AsyncSerialQueue {
  private tail: Promise<void> = Promise.resolve();

  /** Enqueue an async operation. Returns when it completes. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    let resolve: (value: T) => void;
    let reject: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.tail = this.tail.then(
      () => fn().then(resolve!, reject!),
      () => fn().then(resolve!, reject!),
    );

    return promise;
  }
}

// =============================================================================
// WriteBuffer
// =============================================================================

/**
 * Collects mutations (token saves/deletes + full TXF data)
 * between flush cycles. Acts as a staging area for changes
 * that haven't been persisted to IPFS yet.
 */
export class WriteBuffer {
  /** Full TXF data from save() calls — latest wins */
  txfData: TxfStorageDataBase | null = null;

  get isEmpty(): boolean {
    return this.txfData === null;
  }

  clear(): void {
    this.txfData = null;
  }

  /**
   * Merge another buffer's contents into this one (for rollback).
   * Existing (newer) mutations in `this` take precedence over `other`.
   */
  mergeFrom(other: WriteBuffer): void {
    if (other.txfData && !this.txfData) {
      this.txfData = other.txfData;
    }
  }
}
