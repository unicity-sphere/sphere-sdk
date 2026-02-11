/**
 * Browser IPFS State Persistence
 * Uses localStorage for persisting IPFS/IPNS state between sessions
 */

import type { IpfsStatePersistence, IpfsPersistedState } from '../../shared/ipfs';

const KEY_PREFIX = 'sphere_ipfs_';

function seqKey(ipnsName: string): string {
  return `${KEY_PREFIX}seq_${ipnsName}`;
}

function cidKey(ipnsName: string): string {
  return `${KEY_PREFIX}cid_${ipnsName}`;
}

function verKey(ipnsName: string): string {
  return `${KEY_PREFIX}ver_${ipnsName}`;
}

export class BrowserIpfsStatePersistence implements IpfsStatePersistence {
  async load(ipnsName: string): Promise<IpfsPersistedState | null> {
    try {
      const seq = localStorage.getItem(seqKey(ipnsName));
      if (!seq) return null;

      return {
        sequenceNumber: seq,
        lastCid: localStorage.getItem(cidKey(ipnsName)),
        version: parseInt(localStorage.getItem(verKey(ipnsName)) ?? '0', 10),
      };
    } catch {
      return null;
    }
  }

  async save(ipnsName: string, state: IpfsPersistedState): Promise<void> {
    try {
      localStorage.setItem(seqKey(ipnsName), state.sequenceNumber);
      if (state.lastCid) {
        localStorage.setItem(cidKey(ipnsName), state.lastCid);
      } else {
        localStorage.removeItem(cidKey(ipnsName));
      }
      localStorage.setItem(verKey(ipnsName), String(state.version));
    } catch {
      // localStorage might be full or unavailable
    }
  }

  async clear(ipnsName: string): Promise<void> {
    try {
      localStorage.removeItem(seqKey(ipnsName));
      localStorage.removeItem(cidKey(ipnsName));
      localStorage.removeItem(verKey(ipnsName));
    } catch {
      // Ignore cleanup errors
    }
  }
}
