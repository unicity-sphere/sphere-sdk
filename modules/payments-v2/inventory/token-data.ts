import { SphereError } from '../../../core/errors';
import type { ITokenEngine } from '../../../token-engine/engine';
import type { SphereToken } from '../../../token-engine/types';
import type { StoragePort } from '../ports';

import type { InventoryView } from './InventoryView';

export interface TokenDataDeps {
  readonly engine: ITokenEngine;
  readonly view: Pick<InventoryView, 'stateHashOf'>;
  readonly storagePort: Pick<StoragePort, 'getBlobs'>;
}

/** A token's genesis payload, or null. Fetched on demand. */
export async function readTokenData(
  deps: TokenDataDeps,
  tokenId: string
): Promise<Uint8Array | null> {
  return deps.engine.readTokenData(await heldToken(deps, tokenId));
}

export async function readTokenJustification(
  deps: TokenDataDeps,
  tokenId: string
): Promise<Uint8Array | null> {
  return deps.engine.readTokenJustification(await heldToken(deps, tokenId));
}

async function heldToken(deps: TokenDataDeps, tokenId: string): Promise<SphereToken> {
  if (deps.view.stateHashOf(tokenId) === undefined) {
    throw new SphereError(`Token ${tokenId} is not in inventory`, 'VALIDATION_ERROR');
  }
  const bytes = (await deps.storagePort.getBlobs([tokenId])).get(tokenId);
  if (bytes === undefined) {
    throw new SphereError(`Token ${tokenId} has no blob in storage`, 'STORAGE_ERROR');
  }
  return deps.engine.decodeToken({ tokenId, token: bytes });
}
