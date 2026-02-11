/**
 * Node.js IPFS State Persistence
 * Uses the SDK's StorageProvider for persisting IPFS/IPNS state
 */

import type { IpfsStatePersistence, IpfsPersistedState } from '../../shared/ipfs';
import type { StorageProvider } from '../../../storage';

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

export class NodejsIpfsStatePersistence implements IpfsStatePersistence {
  constructor(private readonly storage: StorageProvider) {}

  async load(ipnsName: string): Promise<IpfsPersistedState | null> {
    try {
      const seq = await this.storage.get(seqKey(ipnsName));
      if (!seq) return null;

      const cid = await this.storage.get(cidKey(ipnsName));
      const ver = await this.storage.get(verKey(ipnsName));

      return {
        sequenceNumber: seq,
        lastCid: cid,
        version: parseInt(ver ?? '0', 10),
      };
    } catch {
      return null;
    }
  }

  async save(ipnsName: string, state: IpfsPersistedState): Promise<void> {
    await this.storage.set(seqKey(ipnsName), state.sequenceNumber);
    if (state.lastCid) {
      await this.storage.set(cidKey(ipnsName), state.lastCid);
    } else {
      await this.storage.remove(cidKey(ipnsName));
    }
    await this.storage.set(verKey(ipnsName), String(state.version));
  }

  async clear(ipnsName: string): Promise<void> {
    await this.storage.remove(seqKey(ipnsName));
    await this.storage.remove(cidKey(ipnsName));
    await this.storage.remove(verKey(ipnsName));
  }
}
