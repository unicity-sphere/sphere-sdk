import { SphereError } from '../../core/errors';
import type { ITokenEngine } from '../../token-engine/engine';
import { isCoinlessEnvelope } from '../../token-engine/value-envelope';

import { buildCoinlessPayload } from './machine/payload';
import { buildOps, type MachinePlan } from './machine/TransferMachine';
import type { SendCoinlessRequest } from './api';
import type { StoragePort } from './ports';

export interface CoinlessSpendDeps {
  readonly engine: ITokenEngine;
  readonly storagePort: Pick<StoragePort, 'getBlobs'>;
}

export interface CoinlessSpendInput {
  readonly transferId: string;
  readonly recipientPubkey: string;
  readonly request: SendCoinlessRequest;
  readonly sourceIds: readonly string[];
}

/**
 * The token-addressed twin of the facade's `materialize`: one named source, no
 * coin, no split. `sourceTokens` stays EMPTY — those are the coin rows a UI shows
 * as in-flight, and a coinless token has no amount to show as moving.
 */
export async function materializeCoinlessSpend(
  deps: CoinlessSpendDeps,
  input: CoinlessSpendInput
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
  // The BLOB is the authority, and the question is the ENVELOPE, not the value:
  // `bare_collection` decodes to a null value while carrying coins this SDK cannot
  // read, so a value check would move a valued token recording `assets: []`.
  if (!isCoinlessEnvelope(token.valueEnvelope)) {
    throw new SphereError(
      `Token ${tokenId} carries coin value and cannot be sent with sendCoinless — use send()`,
      'VALIDATION_ERROR'
    );
  }
  const keys = await engine.deliveryKeys(bytes);
  const payload = buildCoinlessPayload(input.recipientPubkey, input.request, {
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
