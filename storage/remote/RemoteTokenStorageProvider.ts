/**
 * RemoteTokenStorageProvider — the Token-Vault v2 remote box.
 *
 * Implements the FROZEN `TokenStorageProvider` contract verbatim. All CAS /
 * cursor / signed-root / rejected state is internal (finding #29). The real
 * bodies land in Phases 6–7; this is the typed skeleton from Task 0.1.
 */

import type { FullIdentity } from '../../types';
import type {
  HistoryRecord,
  LoadResult,
  SaveResult,
  StorageEventCallback,
  SyncResult,
  TokenStorageProvider,
  TxfStorageDataBase,
} from '../storage-provider';

export interface RemoteTokenStorageConfig {
  /** Vault base URL — `NETWORKS[network].vaultUrl`. */
  vaultUrl: string;
  /** Canonical network name (storage scope). */
  network: string;
}

export class RemoteTokenStorageProvider<TData extends TxfStorageDataBase = TxfStorageDataBase>
  implements TokenStorageProvider<TData>
{
  readonly id = 'remote-token-storage';
  readonly name = 'Remote Token Storage (Vault v2)';
  readonly type = 'cloud' as const;

  constructor(_config: RemoteTokenStorageConfig) {
    // Phase 6
  }

  // --- BaseProvider ---

  connect(_config?: unknown): Promise<void> {
    throw new Error('not implemented');
  }

  disconnect(): Promise<void> {
    throw new Error('not implemented');
  }

  isConnected(): boolean {
    throw new Error('not implemented');
  }

  getStatus(): 'disconnected' | 'connecting' | 'connected' | 'error' {
    throw new Error('not implemented');
  }

  // --- TokenStorageProvider ---

  setIdentity(_identity: FullIdentity): void {
    throw new Error('not implemented');
  }

  initialize(): Promise<boolean> {
    throw new Error('not implemented');
  }

  shutdown(): Promise<void> {
    throw new Error('not implemented');
  }

  save(_data: TData): Promise<SaveResult> {
    throw new Error('not implemented');
  }

  load(_identifier?: string): Promise<LoadResult<TData>> {
    throw new Error('not implemented');
  }

  sync(_localData: TData): Promise<SyncResult<TData>> {
    throw new Error('not implemented');
  }

  onEvent(_callback: StorageEventCallback): () => void {
    throw new Error('not implemented');
  }

  // --- History ops ---

  addHistoryEntry(_entry: HistoryRecord): Promise<void> {
    throw new Error('not implemented');
  }

  getHistoryEntries(): Promise<HistoryRecord[]> {
    throw new Error('not implemented');
  }

  hasHistoryEntry(_dedupKey: string): Promise<boolean> {
    throw new Error('not implemented');
  }

  clearHistory(): Promise<void> {
    throw new Error('not implemented');
  }

  importHistoryEntries(_entries: HistoryRecord[]): Promise<number> {
    throw new Error('not implemented');
  }
}
