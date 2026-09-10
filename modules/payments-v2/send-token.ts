import { SphereError } from '../../core/errors';
import type { ITokenEngine } from '../../token-engine/engine';

import { buildTokenPayload } from './machine/payload';
import { buildOps, type MachinePlan } from './machine/TransferMachine';
import type { SendTokenRequest } from './api';
import type { StoragePort } from './ports';

export interface TokenSpendDeps {
  readonly engine: ITokenEngine;
  readonly storagePort: Pick<StoragePort, 'getBlobs'>;
}

export interface TokenSpendInput {
  readonly transferId: string;
  readonly recipientPubkey: string;
  readonly request: SendTokenRequest;
  readonly sourceIds: readonly string[];
}

/**
 * The token-addressed twin of the facade's `materialize`: one named source, no
 * coin, no split. `sourceTokens` stays EMPTY — those are the coin rows a UI shows
 * as in-flight, and a coinless token has no amount to show as moving.
 */
export async function materializeTokenSpend(
  deps: TokenSpendDeps,
  input: TokenSpendInput
): Promise<{
  transferId: string;
  coinId: string;
  plan: MachinePlan;
  sourceIds: readonly string[];
  sourceTokens: never[];
}> {
  const { engine } = deps;
  const tokenId = input.request.tokenId;
  const bytes = (await deps.storagePort.getBlobs([tokenId])).get(tokenId);
  if (bytes === undefined) {
    throw new SphereError(`Selected source ${tokenId} has no blob in storage`, 'STORAGE_ERROR');
  }
  const token = await engine.decodeToken({ tokenId, token: bytes });
  // The mirror said coinless; the BLOB is the authority on what it carries, and the
  // two disagreeing means this would move a valued token with its coins unaccounted.
  if (token.value !== null) {
    throw new SphereError(
      `Token ${tokenId} carries coin value and cannot be sent with sendToken — use send()`,
      'VALIDATION_ERROR'
    );
  }
  const keys = await engine.deliveryKeys(bytes);
  const payload = buildTokenPayload(input.recipientPubkey, input.request, {
    [tokenId]: { local: keys.stateHash, protocol: keys.stateHash },
  });
  const plan: MachinePlan = {
    transferId: input.transferId,
    recipientPubkey: input.recipientPubkey,
    payload,
    ops: buildOps(payload),
    sources: new Map([[tokenId, token]]),
    ...(input.request.memo !== undefined ? { memo: input.request.memo } : {}),
  };
  return { transferId: input.transferId, coinId: '', plan, sourceIds: input.sourceIds, sourceTokens: [] };
}
