import { SphereError } from '../../core/errors';
import type { ITokenEngine } from '../../token-engine/engine';

import { buildWholePayload } from './machine/payload';
import { buildOps, type MachinePlan } from './machine/TransferMachine';
import type { SendWholeTokenRequest } from './api';
import type { StoragePort } from './ports';

export interface WholeSpendDeps {
  readonly engine: ITokenEngine;
  readonly storagePort: Pick<StoragePort, 'getBlobs'>;
}

export interface WholeSpendInput {
  readonly transferId: string;
  readonly recipientPubkey: string;
  readonly request: SendWholeTokenRequest;
  readonly sourceIds: readonly string[];
}

/**
 * The token-addressed twin of the facade's `materialize`: one named source, no
 * coin, no split. `sourceTokens` stays EMPTY — those are the coin rows a UI shows
 * as in-flight, and a coinless token has no amount to show as moving.
 */
export async function materializeWholeSpend(
  deps: WholeSpendDeps,
  input: WholeSpendInput
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
  // A whole spend moves the token AS IS, coins included, so a valued source is fine.
  // The one refusal is `bare_collection`: it carries coins this SDK cannot decode, so
  // the move would be real while the history row could only say `assets: []` — value
  // gone, nothing accounted. The BLOB decides, never the mirror.
  if (token.valueEnvelope === 'bare_collection') {
    throw new SphereError(
      `Token ${tokenId} carries a value envelope this SDK cannot read, so its coins ` +
        'cannot be accounted for; it cannot be sent',
      'VALIDATION_ERROR'
    );
  }
  const keys = await engine.deliveryKeys(bytes);
  const payload = buildWholePayload(input.recipientPubkey, input.request, {
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
