/**
 * IPFS State Persistence
 * Interface and in-memory implementation for persisting IPFS/IPNS state
 */

import type { IpfsStatePersistence, IpfsPersistedState } from './ipfs-types';

// Re-export for convenience
export type { IpfsStatePersistence, IpfsPersistedState };

// =============================================================================
// In-Memory Implementation (for testing)
// =============================================================================

export class InMemoryIpfsStatePersistence implements IpfsStatePersistence {
  private readonly states = new Map<string, IpfsPersistedState>();

  async load(ipnsName: string): Promise<IpfsPersistedState | null> {
    return this.states.get(ipnsName) ?? null;
  }

  async save(ipnsName: string, state: IpfsPersistedState): Promise<void> {
    this.states.set(ipnsName, { ...state });
  }

  async clear(ipnsName: string): Promise<void> {
    this.states.delete(ipnsName);
  }
}
